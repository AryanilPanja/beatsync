import { generateAudioFileName, uploadBytes } from "@/lib/r2";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType, ProviderTrackType } from "@beatsync/shared";
import { DeadHostTracker, asError } from "@/providers/failover";

/**
 * tracks.monochrome.st — the Monochrome project's Tidal-backed stream API
 * (successor of the dead monochrome.tf hifi instances). No key; search returns
 * a fixed result set (no pagination) and /track/<id> streams the lossless FLAC.
 */
export const DEFAULT_MONOCHROME_API_URLS = ["https://tracks.monochrome.st"];

const SEARCH_TIMEOUT_MS = 8_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_CACHED_TRACKS = 500;

interface MonochromeTrack {
  id?: string;
  trackId?: string;
  title?: string;
  artistNames?: string[];
  artwork?: string;
  playable?: boolean;
  /** milliseconds */
  duration?: number;
  isrc?: string;
}

interface TrackMeta {
  title: string;
  artist: string;
  duration?: number;
  imageUrl?: string;
  isrc?: string;
}

function metaFrom(track: MonochromeTrack): TrackMeta | null {
  const id = track.trackId ?? track.id;
  const title = track.title?.trim();
  const artist = (track.artistNames ?? [])
    .map((a) => a.trim())
    .filter(Boolean)
    .join(", ");
  if (!id || !title || !artist) return null;
  const seconds = Math.round((track.duration ?? 0) / 1000);
  return {
    title,
    artist,
    ...(seconds > 0 ? { duration: seconds } : {}),
    ...(track.artwork ? { imageUrl: track.artwork } : {}),
    ...(track.isrc ? { isrc: track.isrc } : {}),
  };
}

export class MonochromeProvider implements MusicProvider {
  readonly name = "monochrome";
  readonly idPrefix = "mono:";
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
        const url = new URL("/search", base);
        url.searchParams.set("q", query);
        const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = (await response.json()) as { tracks?: MonochromeTrack[] };
        const tracks = data?.tracks ?? [];
        const items: ProviderTrackType[] = [];
        for (const track of tracks) {
          if (track.playable === false) continue;
          const meta = metaFrom(track);
          const id = track.trackId ?? track.id;
          if (!meta || !id) continue;
          this.remember(id, meta);
          items.push({
            id: `${this.idPrefix}${id}`,
            title: meta.title,
            artist: meta.artist,
            duration: meta.duration ?? 0,
            ...(meta.imageUrl ? { imageUrl: meta.imageUrl } : {}),
          });
        }
        if (items.length === 0 && tracks.length === 0 && offset === 0) {
          errors.push(`${base}: no tracks in response`);
          continue;
        }
        return { items, total: items.length, offset, limit: items.length };
      } catch (error) {
        this.dead.markDown(base, error);
        errors.push(`${base}: ${asError(error)}`);
      }
    }
    throw new Error(`Monochrome search failed: ${errors.join(" | ")}`);
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
    const meta = this.trackCache.get(trackId);
    const url = new URL(`/track/${encodeURIComponent(trackId)}`, this.apiUrls[0]);
    console.log(`Downloading audio from: ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to download audio: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();

    const displayName = meta ? `${meta.artist} - ${meta.title}` : (trackName ?? `track-${trackId}`);
    const fileName = generateAudioFileName(`${displayName}.flac`);
    console.log(`Uploading to storage: room-${roomId}/${fileName}`);
    const publicUrl = await uploadBytes(bytes, roomId, fileName, "audio/flac");

    return {
      url: publicUrl,
      ...(meta ?? { ...(trackName ? { title: trackName } : {}) }),
    };
  }

  private remember(trackId: string, meta: TrackMeta): void {
    this.trackCache.delete(trackId);
    this.trackCache.set(trackId, meta);
    if (this.trackCache.size > MAX_CACHED_TRACKS) {
      const oldest = this.trackCache.keys().next().value;
      if (oldest !== undefined) this.trackCache.delete(oldest);
    }
  }
}
