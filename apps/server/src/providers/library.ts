import { parseTrackName } from "@/managers/LyricsManager";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType } from "@beatsync/shared";
import { parseFile } from "music-metadata";
import pLimit from "p-limit";
import { createHash } from "crypto";
import { readdir } from "fs/promises";
import { basename, extname, join, relative } from "path";

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav"]);
const PAGE_SIZE = 20;
const PARSE_CONCURRENCY = 8;
const MAX_CACHED_ARTWORK = 100;

interface LibraryTrack {
  id: string;
  path: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  isrc?: string;
  hasArtwork: boolean;
  /** Normalized "title artist album" for matching */
  searchText: string;
  normalizedTitle: string;
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Stable across restarts (and therefore across state backups) as long as the file doesn't move */
export const libraryTrackId = (relativePath: string) =>
  createHash("sha1").update(relativePath).digest("hex").slice(0, 16);

async function listAudioFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) return listAudioFiles(fullPath);
        return entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? [fullPath] : [];
      })
  );
  return nested.flat();
}

/**
 * "My Library": serves the music files in a local folder (MUSIC_LIBRARY_DIR).
 * Files are indexed once from their embedded tags; tracks stream straight from disk via
 * /library/audio/<id>, so nothing is copied into storage.
 */
export class LibraryProvider implements MusicProvider {
  readonly name = "library";
  private tracks = new Map<string, LibraryTrack>();
  private indexing: Promise<void> | null = null;
  private artworkCache = new Map<string, { data: Uint8Array; mimeType: string } | null>();

  constructor(private readonly rootDir: string) {}

  /** (Re)build the index. Safe to call again; concurrent calls share one run. */
  index(): Promise<void> {
    this.indexing ??= this.buildIndex().finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }

  get size(): number {
    return this.tracks.size;
  }

  private async buildIndex(): Promise<void> {
    const started = performance.now();
    const files = await listAudioFiles(this.rootDir);
    const limit = pLimit(PARSE_CONCURRENCY);
    const tracks = new Map<string, LibraryTrack>();

    await Promise.all(
      files.map((path) =>
        limit(async () => {
          const track = await this.readTrack(path);
          tracks.set(track.id, track);
        })
      )
    );

    this.tracks = tracks;
    this.artworkCache.clear();
    console.log(
      `🎵 Library indexed: ${tracks.size} tracks from ${this.rootDir} in ${((performance.now() - started) / 1000).toFixed(1)}s`
    );
  }

  private async readTrack(path: string): Promise<LibraryTrack> {
    const fromName = parseTrackName(basename(path, extname(path)));
    let tags: Awaited<ReturnType<typeof parseFile>> | null = null;
    try {
      tags = await parseFile(path, { duration: true });
    } catch (error) {
      console.warn(`Library: could not read tags from ${path}:`, error);
    }

    // Empty tags count as missing
    const nonEmpty = (value?: string) => (value?.trim() ? value.trim() : undefined);
    const title = nonEmpty(tags?.common.title) ?? fromName.title;
    const artist = nonEmpty(tags?.common.artist) ?? nonEmpty(fromName.artist) ?? "Unknown artist";
    const album = nonEmpty(tags?.common.album);

    return {
      id: libraryTrackId(relative(this.rootDir, path)),
      path,
      title,
      artist,
      album,
      duration: Math.round(tags?.format.duration ?? 0),
      isrc: tags?.common.isrc?.[0],
      hasArtwork: (tags?.common.picture?.length ?? 0) > 0,
      searchText: normalize(`${title} ${artist} ${album ?? ""}`),
      normalizedTitle: normalize(title),
    };
  }

  async search(query: string, offset: number): Promise<ProviderSearchResultType> {
    if (this.indexing) await this.indexing;

    const wanted = normalize(query);
    const words = wanted.split(" ").filter(Boolean);
    if (words.length === 0) return { items: [], total: 0, offset, limit: PAGE_SIZE };

    // Rank: exact title, then title prefix, then title contains, then matches in artist/album only
    const rank = (track: LibraryTrack) => {
      if (track.normalizedTitle === wanted) return 0;
      if (track.normalizedTitle.startsWith(wanted)) return 1;
      if (track.normalizedTitle.includes(wanted)) return 2;
      return 3;
    };

    const matches = [...this.tracks.values()]
      .filter((track) => words.every((word) => track.searchText.includes(word)))
      .sort((a, b) => rank(a) - rank(b) || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));

    return {
      items: matches.slice(offset, offset + PAGE_SIZE).map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        imageUrl: track.hasArtwork ? `/library/artwork/${track.id}` : undefined,
      })),
      total: matches.length,
      offset,
      limit: PAGE_SIZE,
    };
  }

  async getAudioSource({ trackId }: { trackId: string }): Promise<AudioSourceType> {
    if (this.indexing) await this.indexing;

    const track = this.tracks.get(trackId);
    if (!track) throw new Error(`Unknown library track: ${trackId}`);

    return {
      url: `/library/audio/${track.id}`,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration || undefined,
      isrc: track.isrc,
      imageUrl: track.hasArtwork ? `/library/artwork/${track.id}` : undefined,
    };
  }

  /** File path for an indexed id. Only ids from the index resolve — never arbitrary paths. */
  getTrackPath(trackId: string): string | undefined {
    return this.tracks.get(trackId)?.path;
  }

  async getArtwork(trackId: string): Promise<{ data: Uint8Array; mimeType: string } | null> {
    const track = this.tracks.get(trackId);
    if (!track?.hasArtwork) return null;

    if (this.artworkCache.has(trackId)) return this.artworkCache.get(trackId) ?? null;

    const tags = await parseFile(track.path, { skipPostHeaders: true });
    const picture = tags.common.picture?.[0];
    const artwork = picture ? { data: picture.data, mimeType: picture.format } : null;

    if (this.artworkCache.size >= MAX_CACHED_ARTWORK) {
      const oldest = this.artworkCache.keys().next().value;
      if (oldest !== undefined) this.artworkCache.delete(oldest);
    }
    this.artworkCache.set(trackId, artwork);
    return artwork;
  }
}
