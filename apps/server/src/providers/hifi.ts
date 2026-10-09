import { generateAudioFileName, uploadBytes } from "@/lib/r2";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType, ProviderTrackType } from "@beatsync/shared";
import { RawSearchResponseSchema, StreamResponseSchema, TrackParamsSchema } from "@beatsync/shared";

/**
 * Community hifi-api instances (https://github.com/binimum/hifi-api, Tidal catalog),
 * configurable via env so dead instances can be swapped without a deploy.
 */
export const DEFAULT_HIFI_API_URLS = ["https://hifi.geeked.wtf", "https://eu-central.monochrome.tf"];
export const DEFAULT_HIFI_STREAMING_URLS = ["https://hifi.geeked.wtf", "https://maus.qqdl.site"];

const SEARCH_PAGE_LIMIT = 25;
const MAX_CACHED_TRACKS = 500;
const SEARCH_TIMEOUT_MS = 4_000;
const STREAM_LOOKUP_TIMEOUT_MS = 10_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEAD_INSTANCE_COOLDOWN_MS = 5 * 60_000;
const ARTWORK_SIZE = "640x640.jpg";
const DEFAULT_QUALITY = "LOSSLESS";

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
};

interface TidalArtist {
  name?: string;
}

/** The subset of hifi-api's Tidal track JSON we need (see the /search/ sample in its README). */
interface TidalTrack {
  id?: number | string;
  title?: string;
  version?: string | null;
  duration?: number;
  isrc?: string | null;
  artist?: TidalArtist;
  artists?: TidalArtist[];
  album?: { title?: string; cover?: string | null };
}

/** Song details kept from search results so queue entries get full metadata. */
interface TrackMeta {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  imageUrl?: string;
  isrc?: string;
  version?: string;
}

export function parseUrlList(value: string | undefined, fallback: string[]): string[] {
  const list = (value ?? "")
    .split(/[\s,]+/)
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

export function tidalArtworkUrl(cover: string | null | undefined): string | undefined {
  if (!cover) return undefined;
  return `https://resources.tidal.com/images/${cover.split("-").join("/")}/${ARTWORK_SIZE}`;
}

function joinArtistNames(track: TidalTrack): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of (track.artists?.length ? track.artists : [track.artist]).map((a) => a?.name)) {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names.join(", ");
}

function metaFromTidalTrack(track: TidalTrack): TrackMeta | null {
  const title = track.title?.trim();
  const artist = joinArtistNames(track);
  if (!track.id || !title || !artist) return null;
  return {
    title,
    artist,
    ...(track.album?.title ? { album: track.album.title } : {}),
    ...(track.duration ? { duration: track.duration } : {}),
    ...(tidalArtworkUrl(track.album?.cover) ? { imageUrl: tidalArtworkUrl(track.album?.cover) } : {}),
    ...(track.isrc ? { isrc: track.isrc } : {}),
  };
}

function toProviderTrack(meta: TrackMeta, id: string, version?: string): ProviderTrackType {
  return {
    id,
    title: meta.title,
    artist: meta.artist,
    duration: meta.duration ?? 0,
    ...(meta.album ? { album: meta.album } : {}),
    ...(meta.imageUrl ? { imageUrl: meta.imageUrl } : {}),
    ...(version ? { version } : {}),
  };
}

function mapQobuzTrack(track: {
  id: number;
  title: string;
  version?: string | null;
  duration: number;
  performer: { name: string };
  album: { title: string; image?: { thumbnail?: string; small?: string }; artists?: { name: string }[] };
}): ProviderTrackType {
  const artists = [track.performer.name];
  for (const artist of track.album.artists ?? []) {
    if (!artists.includes(artist.name)) artists.push(artist.name);
  }
  return {
    id: String(track.id),
    title: track.title,
    artist: artists.join(", "),
    album: track.album.title,
    duration: track.duration,
    imageUrl: track.album.image?.thumbnail ?? track.album.image?.small,
    ...(track.version ? { version: track.version } : {}),
  };
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Unreachable hosts (bad DNS, refused TLS) stay skipped for a cooldown window. */
function isDeadHostError(error: unknown): boolean {
  const message = asError(error).toLowerCase();
  return (
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("eai_again") ||
    message.includes("unexpected eof") ||
    message.includes("abort") ||
    message.includes("timeout")
  );
}

function extensionFor(contentType: string): string {
  return EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0].trim()] ?? ".mp3";
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Tidal catalog behind a pool of community hifi-api instances, with failover.
 * Search goes through HIFI_API_URLS (falling back to the legacy Qobuz-proxy shape
 * per instance), streaming/download through HIFI_STREAMING_URLS. Tracks are
 * downloaded once and copied into the room's storage folder.
 */
export class HifiProvider implements MusicProvider {
  readonly name = "hifi";
  private readonly quality: string;
  private readonly trackCache = new Map<string, TrackMeta>();
  private readonly deadUntil = new Map<string, number>();

  constructor(
    private readonly apiUrls: string[],
    private readonly streamingUrls: string[]
  ) {
    this.quality = process.env.HIFI_QUALITY?.trim() ?? DEFAULT_QUALITY;
  }

  private isDown(base: string): boolean {
    const until = this.deadUntil.get(base);
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.deadUntil.delete(base);
      return false;
    }
    return true;
  }

  private markDown(base: string, error: unknown): void {
    if (isDeadHostError(error)) this.deadUntil.set(base, Date.now() + DEAD_INSTANCE_COOLDOWN_MS);
  }

  async search(query: string, offset: number): Promise<ProviderSearchResultType> {
    const errors: string[] = [];
    for (const base of this.apiUrls) {
      if (this.isDown(base)) {
        errors.push(`${base}: skipped (recently unreachable)`);
        continue;
      }
      for (const shape of ["hifi-api", "legacy"] as const) {
        try {
          const result =
            shape === "hifi-api"
              ? await this.searchHifiApi(base, query, offset)
              : await this.searchLegacy(base, query, offset);
          if (result) return result;
          errors.push(`${base} (${shape}): unexpected response`);
        } catch (error) {
          this.markDown(base, error);
          errors.push(`${base} (${shape}): ${asError(error)}`);
        }
      }
    }
    throw new Error(`All music API instances failed: ${errors.join(" | ")}`);
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
      const info = await this.fetchTrackInfo(trackId);
      meta = info ?? undefined;
      if (meta) this.remember(trackId, meta);
    }

    const { audioUrl, contentType } = await this.resolveStream(trackId);
    console.log(`Downloading audio from: ${audioUrl}`);
    const response = await fetch(audioUrl, { signal: AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to download audio: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();

    const displayName = meta
      ? `${meta.artist} - ${meta.title}${meta.version ? ` (${meta.version})` : ""}`
      : (trackName ?? `track-${trackId}`);
    const fileName = generateAudioFileName(`${displayName}${extensionFor(contentType)}`);
    console.log(`Uploading to storage: room-${roomId}/${fileName}`);
    const url = await uploadBytes(bytes, roomId, fileName, contentType);

    return omitUndefined({
      url,
      ...(meta ?? {}),
      ...(!meta && trackName ? { title: trackName } : {}),
    });
  }

  private async searchHifiApi(base: string, query: string, offset: number): Promise<ProviderSearchResultType | null> {
    const url = new URL("/search/", base);
    url.searchParams.set("s", query);
    url.searchParams.set("offset", offset.toString());
    url.searchParams.set("limit", SEARCH_PAGE_LIMIT.toString());

    const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = (await response.json()) as {
      data?: { items?: TidalTrack[]; totalNumberOfItems?: number };
    };
    const data = json?.data;
    if (!data || !Array.isArray(data.items)) return null;

    const items: ProviderTrackType[] = [];
    for (const track of data.items) {
      const meta = metaFromTidalTrack(track);
      if (!meta) continue;
      this.remember(String(track.id), { ...meta, ...(track.version ? { version: track.version } : {}) });
      items.push(toProviderTrack(meta, String(track.id), track.version ?? undefined));
    }
    return { items, total: data.totalNumberOfItems ?? items.length, offset, limit: SEARCH_PAGE_LIMIT };
  }

  private async searchLegacy(base: string, query: string, offset: number): Promise<ProviderSearchResultType | null> {
    const url = new URL("/api/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("offset", offset.toString());

    const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const { tracks } = RawSearchResponseSchema.parse(await response.json()).data;
    const items: ProviderTrackType[] = [];
    for (const track of tracks.items) {
      const item = mapQobuzTrack(track);
      this.remember(item.id, {
        title: item.title,
        artist: item.artist,
        ...(item.album ? { album: item.album } : {}),
        ...(item.duration ? { duration: item.duration } : {}),
        ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
        ...(item.version ? { version: item.version } : {}),
        ...(track.isrc ? { isrc: track.isrc } : {}),
      });
      items.push(item);
    }
    return { items, total: tracks.total, offset: tracks.offset, limit: tracks.limit };
  }

  private async fetchTrackInfo(trackId: string): Promise<TrackMeta | null> {
    for (const base of this.apiUrls) {
      if (this.isDown(base)) continue;
      try {
        const url = new URL("/info/", base);
        url.searchParams.set("id", trackId);
        const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
        if (!response.ok) continue;
        const json = (await response.json()) as { data?: TidalTrack };
        const meta = metaFromTidalTrack(json?.data ?? {});
        if (meta) return meta;
      } catch (error) {
        this.markDown(base, error);
      }
    }
    return null;
  }

  private async resolveStream(trackId: string): Promise<{ audioUrl: string; contentType: string }> {
    const errors: string[] = [];
    for (const base of this.streamingUrls) {
      if (this.isDown(base)) {
        errors.push(`${base}: skipped (recently unreachable)`);
        continue;
      }
      try {
        return await this.resolveStreamHifiApi(base, trackId);
      } catch (error) {
        this.markDown(base, error);
        errors.push(`${base} (hifi-api): ${asError(error)}`);
      }
      try {
        return await this.resolveStreamLegacy(base, trackId);
      } catch (error) {
        this.markDown(base, error);
        errors.push(`${base} (legacy): ${asError(error)}`);
      }
    }
    throw new Error(`All streaming instances failed for track ${trackId}: ${errors.join(" | ")}`);
  }

  private async resolveStreamHifiApi(base: string, trackId: string) {
    const url = new URL("/track/", base);
    url.searchParams.set("id", trackId);
    url.searchParams.set("quality", this.quality);

    const response = await fetch(url, { signal: AbortSignal.timeout(STREAM_LOOKUP_TIMEOUT_MS) });
    if (response.status === 202) throw new Error("playback request queued (202), try again shortly");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = (await response.json()) as {
      data?: { manifest?: string; manifestMimeType?: string };
    };
    const data = json?.data;
    if (!data?.manifest) throw new Error("no manifest in response");
    if (typeof data.manifestMimeType === "string" && data.manifestMimeType.includes("dash")) {
      throw new Error("DASH manifest not supported");
    }

    const manifest = JSON.parse(Buffer.from(data.manifest, "base64").toString("utf-8")) as {
      encryptionType?: string;
      urls?: string[];
      mimeType?: string;
    };
    if (manifest.encryptionType && manifest.encryptionType !== "NONE") {
      throw new Error("encrypted stream");
    }
    if (!Array.isArray(manifest.urls) || manifest.urls.length === 0) {
      throw new Error("manifest has no stream URLs");
    }
    return { audioUrl: manifest.urls[0], contentType: manifest.mimeType ?? "audio/flac" };
  }

  private async resolveStreamLegacy(base: string, trackId: string) {
    const { id } = TrackParamsSchema.parse({ id: Number(trackId) });

    const url = new URL("/api/track", base);
    url.searchParams.set("id", id.toString());
    const response = await fetch(url, { signal: AbortSignal.timeout(STREAM_LOOKUP_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const stream = StreamResponseSchema.parse(await response.json());
    if (!stream.success) throw new Error("Failed to get stream URL");
    return { audioUrl: stream.data.url, contentType: "audio/mpeg" };
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
