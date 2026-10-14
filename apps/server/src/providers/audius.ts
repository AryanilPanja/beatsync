import { generateAudioFileName, uploadBytes } from "@/lib/r2";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType, ProviderTrackType } from "@beatsync/shared";
import { DeadHostTracker, asError } from "@/providers/failover";

/**
 * Audius — decentralized streaming platform with a fully public API (no key, just an
 * app_name param). Full-length tracks, but the catalog skews independent artists.
 * Discovery nodes are interchangeable; failover across a configurable list.
 */
export const DEFAULT_AUDIUS_API_URLS = ["https://discoveryprovider.audius.co"];

const SEARCH_PAGE_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 8_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 60_000;
const APP_NAME = "beatsync";

interface AudiusTrack {
  id?: string;
  title?: string;
  duration?: number;
  is_streamable?: boolean;
  is_delete?: boolean;
  genre?: string;
  user?: { name?: string };
  artwork?: Record<string, string | undefined>;
}

interface TrackMeta {
  title: string;
  artist: string;
  duration?: number;
  imageUrl?: string;
}

function metaFrom(track: AudiusTrack): { id: string; meta: TrackMeta } | null {
  const title = track.title?.trim();
  const artist = track.user?.name?.trim();
  if (!track.id || !title || !artist) return null;
  const artwork = track.artwork?.["480x480"] ?? track.artwork?.["150x150"] ?? track.artwork?.["1000x1000"];
  return {
    id: track.id,
    meta: {
      title,
      artist,
      ...(track.duration ? { duration: track.duration } : {}),
      ...(artwork ? { imageUrl: artwork } : {}),
    },
  };
}

function toTrack(meta: TrackMeta, id: string): ProviderTrackType {
  return {
    id: `aud:${id}`,
    title: meta.title,
    artist: meta.artist,
    duration: meta.duration ?? 0,
    ...(meta.imageUrl ? { imageUrl: meta.imageUrl } : {}),
  };
}

export class AudiusProvider implements MusicProvider {
  readonly name = "audius";
  readonly idPrefix = "aud:";
  private readonly dead = new DeadHostTracker();
  private readonly trackCache = new Map<string, TrackMeta>();

  constructor(private readonly apiUrls: string[]) {}

  async search(query: string, offset: number): Promise<ProviderSearchResultType> {
    const errors: string[] = [];
    for (const base of this.apiUrls) {
      if (this.dead.isDown(base)) {
        errors.push(`${base}: skipped (recently unreachable)`);
        continue;
      }
      try {
        const url = new URL("/v1/tracks/search", base);
        url.searchParams.set("query", query);
        url.searchParams.set("app_name", APP_NAME);
        const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = (await response.json()) as { data?: AudiusTrack[] };
        const tracks = (data?.data ?? []).filter((t) => t.is_streamable !== false && !t.is_delete);
        const items: ProviderTrackType[] = [];
        for (const track of tracks.slice(0, SEARCH_PAGE_LIMIT)) {
          const parsed = metaFrom(track);
          if (!parsed) continue;
          this.remember(parsed.id, parsed.meta);
          items.push(toTrack(parsed.meta, parsed.id));
        }
        return { items, total: items.length, offset, limit: SEARCH_PAGE_LIMIT };
      } catch (error) {
        this.dead.markDown(base, error);
        errors.push(`${base}: ${asError(error)}`);
      }
    }
    throw new Error(`Audius search failed: ${errors.join(" | ")}`);
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
    let meta = this.trackCache.get(trackId);
    if (!meta) {
      const info = await this.fetchTrackMeta(trackId);
      meta = info ?? undefined;
      if (meta) this.remember(trackId, meta);
    }

    const url = new URL(`/v1/tracks/${encodeURIComponent(trackId)}/stream`, this.apiUrls[0]);
    url.searchParams.set("app_name", APP_NAME);
    console.log(`Downloading audio from: ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to download audio: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg";

    const displayName = meta ? `${meta.artist} - ${meta.title}` : (trackName ?? `track-${trackId}`);
    const extension = contentType === "audio/mpeg" ? ".mp3" : ".m4a";
    const fileName = generateAudioFileName(`${displayName}${extension}`);
    console.log(`Uploading to storage: room-${roomId}/${fileName}`);
    const publicUrl = await uploadBytes(bytes, roomId, fileName, contentType);

    return {
      url: publicUrl,
      ...(meta ?? { ...(trackName ? { title: trackName } : {}) }),
    };
  }

  private async fetchTrackMeta(trackId: string): Promise<TrackMeta | null> {
    for (const base of this.apiUrls) {
      if (this.dead.isDown(base)) continue;
      try {
        const url = new URL(`/v1/tracks/${encodeURIComponent(trackId)}`, base);
        url.searchParams.set("app_name", APP_NAME);
        const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
        if (!response.ok) continue;
        const data = (await response.json()) as { data?: AudiusTrack };
        return data?.data ? (metaFrom(data.data)?.meta ?? null) : null;
      } catch (error) {
        this.dead.markDown(base, error);
      }
    }
    return null;
  }

  private remember(trackId: string, meta: TrackMeta): void {
    this.trackCache.delete(trackId);
    this.trackCache.set(trackId, meta);
  }
}
