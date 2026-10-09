import { generateAudioFileName, uploadBytes } from "@/lib/r2";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType, ProviderTrackType } from "@beatsync/shared";
import { createDecipheriv } from "crypto";

/**
 * JioSaavn's public web API (www.jiosaavn.com/api.php) — free, no key, no proxy.
 * Search + song details work directly; stream URLs are DES-ECB encrypted with a
 * fixed key, and the _96 kbps preview in the URL can be swapped for the full
 * 320 kbps file when the track is flagged 320kbps.
 */
export const DEFAULT_SAAVN_API_URL = "https://www.jiosaavn.com";

const PAGE_SIZE = 30;
const SEARCH_TIMEOUT_MS = 8_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 60_000;
const DES_KEY = Buffer.from("38346591", "latin1");

interface SaavnArtist {
  name?: string;
  role?: string;
}

interface SaavnSong {
  id?: string;
  title?: string;
  subtitle?: string;
  perma_url?: string;
  image?: string;
  year?: string;
  language?: string;
  more_info?: {
    album?: string;
    duration?: string;
    encrypted_media_url?: string;
    "320kbps"?: string;
    artistMap?: {
      primary_artists?: SaavnArtist[];
      featured_artists?: SaavnArtist[];
    };
  };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Artwork comes back at 150x150; the same path exists at 500x500. */
function largeImage(image: string | undefined): string | undefined {
  if (!image) return undefined;
  return image.replace(/^http:\/\//, "https://").replace(/150x150|50x50/g, "500x500");
}

function songToken(song: SaavnSong): string | undefined {
  const fromPerma = song.perma_url?.split("/").pop();
  if (fromPerma) return fromPerma;
  return song.id;
}

function songArtists(song: SaavnSong): string {
  const map = song.more_info?.artistMap;
  const names = [...(map?.primary_artists ?? []), ...(map?.featured_artists ?? [])]
    .map((a) => a.name?.trim())
    .filter((name): name is string => Boolean(name));
  const unique = [...new Set(names)];
  if (unique.length > 0) return unique.join(", ");
  const subtitle = song.subtitle ?? "";
  // "Artist - Title" / "Artist A, Artist B - Album" fallbacks
  const dash = subtitle.indexOf(" - ");
  return dash > 0 ? decodeEntities(subtitle.slice(0, dash)) : "Unknown artist";
}

function mapSong(song: SaavnSong, id: string): ProviderTrackType | null {
  const title = song.title ? decodeEntities(song.title) : undefined;
  if (!id || !title) return null;
  return {
    id,
    title,
    artist: songArtists(song),
    duration: Number(song.more_info?.duration) || 0,
    ...(song.more_info?.album ? { album: decodeEntities(song.more_info.album) } : {}),
    ...(largeImage(song.image) ? { imageUrl: largeImage(song.image) } : {}),
  };
}

export function decryptMediaUrl(encrypted: string): string {
  const decipher = createDecipheriv("des-ecb", DES_KEY, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()])
    .toString("utf-8")
    .replace(/\0+$/, "")
    .trim();
}

/** The decrypted URL points at the 96 kbps preview; JioSaavn serves 320 kbps at the same path. */
export function upgradeTo320(url: string): string {
  return url.replace(/_96\.mp4$/, "_320.mp4");
}

async function fetchJson(url: string | URL, timeoutMs = SEARCH_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`JioSaavn API: HTTP ${response.status}`);
  return response.json();
}

/**
 * Full-length 320 kbps AAC straight from JioSaavn. Tracks are downloaded once and
 * copied into the room's storage folder, like every other provider.
 */
export class SaavnProvider implements MusicProvider {
  readonly name = "saavn";

  constructor(private readonly apiUrl: string = process.env.SAAVN_API_URL?.trim() ?? DEFAULT_SAAVN_API_URL) {}

  async search(query: string, offset: number): Promise<ProviderSearchResultType> {
    const page = Math.max(0, Math.floor(offset / PAGE_SIZE));
    const url = new URL("/api.php", this.apiUrl);
    url.searchParams.set("__call", "search.getResults");
    url.searchParams.set("q", query);
    url.searchParams.set("p", page.toString());
    url.searchParams.set("n", PAGE_SIZE.toString());
    url.searchParams.set("api_version", "4");
    url.searchParams.set("_format", "json");
    url.searchParams.set("_marker", "0");
    url.searchParams.set("ctx", "web6dot0");

    const data = (await fetchJson(url)) as { total?: number; results?: SaavnSong[] };
    const songs = data.results ?? [];

    // Client offsets are absolute; slice away the items before the offset within this page.
    const skip = offset - page * PAGE_SIZE;
    const items: ProviderTrackType[] = [];
    for (const song of songs.slice(skip)) {
      const id = songToken(song);
      const item = mapSong(song, id ?? "");
      if (!item) continue;
      items.push(item);
    }
    return { items, total: data.total ?? items.length, offset, limit: PAGE_SIZE };
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
    const url = new URL("/api.php", this.apiUrl);
    url.searchParams.set("__call", "webapi.get");
    url.searchParams.set("token", trackId);
    url.searchParams.set("type", "song");
    url.searchParams.set("api_version", "4");
    url.searchParams.set("_format", "json");
    url.searchParams.set("_marker", "0");
    url.searchParams.set("ctx", "web6dot0");

    const data = (await fetchJson(url)) as { songs?: SaavnSong[] | Record<string, SaavnSong> };
    const songs = Array.isArray(data.songs) ? data.songs : Object.values(data.songs ?? {});
    const song = songs[0];
    if (!song?.more_info?.encrypted_media_url) {
      throw new Error(`Unknown Saavn track: ${trackId}`);
    }

    let streamUrl = decryptMediaUrl(song.more_info.encrypted_media_url);
    const is320 = song.more_info["320kbps"] === "true";
    if (is320) streamUrl = upgradeTo320(streamUrl);

    console.log(`Downloading audio from: ${streamUrl}`);
    const response = await fetch(streamUrl, { signal: AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to download audio: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();

    const item = mapSong(song, trackId);
    const displayName = item ? `${item.artist} - ${item.title}` : (trackName ?? `track-${trackId}`);
    const fileName = generateAudioFileName(`${displayName}${is320 ? "_320" : ""}.m4a`);
    console.log(`Uploading to storage: room-${roomId}/${fileName}`);
    const publicUrl = await uploadBytes(bytes, roomId, fileName, "audio/mp4");

    if (!item) return { url: publicUrl, ...(trackName ? { title: trackName } : {}) };
    return {
      url: publicUrl,
      title: item.title,
      artist: item.artist,
      ...(item.album ? { album: item.album } : {}),
      ...(item.duration ? { duration: item.duration } : {}),
      ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
    };
  }
}
