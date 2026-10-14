import { generateAudioFileName, uploadBytes } from "@/lib/r2";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType, ProviderTrackType } from "@beatsync/shared";
import { DeadHostTracker, asError } from "@/providers/failover";

/**
 * YouTube search + audio streams via public Invidious instances. The instances are
 * community-hosted and die often, so the list is env-configurable with failover.
 * AAC (itag 140) is preferred for Safari compatibility; Opus is the fallback.
 */
export const DEFAULT_INVIDIOUS_API_URLS = ["https://invidious.f5.si"];

const SEARCH_PAGE_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 8_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 60_000;

interface InvidiousVideo {
  type?: string;
  videoId?: string;
  title?: string;
  author?: string;
  lengthSeconds?: number;
  liveNow?: boolean;
  isUpcoming?: boolean;
  videoThumbnails?: { url?: string }[];
}

interface InvidiousVideoDetail {
  title?: string;
  author?: string;
  lengthSeconds?: number;
  adaptiveFormats?: {
    itag?: string;
    url?: string;
    type?: string;
    container?: string;
    bitrate?: string | number;
  }[];
}

const CONTENT_TYPE_BY_CONTAINER: Record<string, { contentType: string; extension: string }> = {
  m4a: { contentType: "audio/mp4", extension: ".m4a" },
  mp4: { contentType: "audio/mp4", extension: ".m4a" },
  webm: { contentType: "audio/webm", extension: ".webm" },
};

function cleanAuthor(author: string | undefined): string {
  return (author ?? "").replace(/ - Topic$/, "").trim();
}

export class InvidiousProvider implements MusicProvider {
  readonly name = "invidious";
  readonly idPrefix = "inv:";
  private readonly dead = new DeadHostTracker();

  constructor(private readonly apiUrls: string[]) {}

  async search(query: string, offset: number): Promise<ProviderSearchResultType> {
    const errors: string[] = [];
    for (const base of this.apiUrls) {
      if (this.dead.isDown(base)) {
        errors.push(`${base}: skipped (recently unreachable)`);
        continue;
      }
      try {
        const url = new URL("/api/v1/search", base);
        url.searchParams.set("q", query);
        url.searchParams.set("type", "video");
        const response = await fetch(url, {
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = (await response.json()) as InvidiousVideo[] | { error?: string };
        if (!Array.isArray(data)) {
          throw new Error(asError(data.error ?? "unexpected response"));
        }

        const items: ProviderTrackType[] = [];
        for (const video of data) {
          const author = cleanAuthor(video.author);
          if (video.type && video.type !== "video") continue;
          if (video.liveNow || video.isUpcoming) continue;
          if (!video.videoId || !video.title || !author) continue;
          const thumb = video.videoThumbnails?.[0]?.url;
          items.push({
            id: `${this.idPrefix}${video.videoId}`,
            title: video.title,
            artist: author,
            duration: video.lengthSeconds ?? 0,
            ...(thumb ? { imageUrl: thumb.startsWith("http") ? thumb : new URL(thumb, base).toString() } : {}),
          });
          if (items.length >= SEARCH_PAGE_LIMIT) break;
        }
        return { items, total: items.length, offset, limit: SEARCH_PAGE_LIMIT };
      } catch (error) {
        this.dead.markDown(base, error);
        errors.push(`${base}: ${asError(error)}`);
      }
    }
    throw new Error(`Invidious search failed: ${errors.join(" | ")}`);
  }

  async getAudioSource({
    trackId,
    roomId,
    trackName,
  }: {
    trackId: string;
    roomId: string;
    trackName?: string;
  }): Promise<AudioSourceType> {
    const errors: string[] = [];
    for (const base of this.apiUrls) {
      if (this.dead.isDown(base)) {
        errors.push(`${base}: skipped (recently unreachable)`);
        continue;
      }
      try {
        const url = new URL(`/api/v1/videos/${encodeURIComponent(trackId)}`, base);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const detail = (await response.json()) as InvidiousVideoDetail;
        const streams = (detail.adaptiveFormats ?? []).filter((f) => f.url && f.type?.startsWith("audio"));
        if (streams.length === 0) throw new Error("no audio streams in response");

        // itag 140 = AAC m4a, playable everywhere; anything else sorted by bitrate.
        const aac = streams.find((f) => f.itag === "140");
        const stream = aac ?? [...streams].sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0];
        const streamUrl = stream.url;
        if (!streamUrl) throw new Error("audio stream has no URL");
        const container = CONTENT_TYPE_BY_CONTAINER[stream.container ?? "m4a"] ?? CONTENT_TYPE_BY_CONTAINER.m4a;

        console.log(`Downloading audio from: ${streamUrl}`);
        const audio = await fetch(streamUrl, { signal: AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS) });
        if (!audio.ok) throw new Error(`Failed to download audio: HTTP ${audio.status}`);
        const bytes = await audio.arrayBuffer();

        const artist = cleanAuthor(detail.author);
        const displayName = artist && detail.title ? `${artist} - ${detail.title}` : (trackName ?? `track-${trackId}`);
        const fileName = generateAudioFileName(`${displayName}${container.extension}`);
        console.log(`Uploading to storage: room-${roomId}/${fileName}`);
        const publicUrl = await uploadBytes(bytes, roomId, fileName, container.contentType);

        return {
          url: publicUrl,
          ...(detail.title ? { title: detail.title } : {}),
          ...(artist ? { artist } : {}),
          ...(detail.lengthSeconds ? { duration: detail.lengthSeconds } : {}),
        };
      } catch (error) {
        this.dead.markDown(base, error);
        errors.push(`${base}: ${asError(error)}`);
      }
    }
    throw new Error(`Invidious stream lookup failed for ${trackId}: ${errors.join(" | ")}`);
  }
}
