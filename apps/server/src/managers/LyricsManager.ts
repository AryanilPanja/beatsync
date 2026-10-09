import type { GetLyricsQueryType, LyricsResponseType } from "@beatsync/shared";
import { z } from "zod";

// LRCLIB (https://lrclib.net): free, keyless, community-maintained synced lyrics.
// Requests go through the server so a whole room shares one lookup per track and
// so we can send the identifying User-Agent LRCLIB asks for (browsers can't).
const DEFAULT_API_URL = "https://lrclib.net";
const USER_AGENT = "Beatsync (https://github.com/freeman-jiang/beatsync)";
const REQUEST_TIMEOUT_MS = 5_000;
const DURATION_TOLERANCE_S = 3;
const MAX_CACHE_ENTRIES = 500;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;

const LrclibRecordSchema = z.object({
  trackName: z.string(),
  artistName: z.string(),
  duration: z.number().nullish(),
  instrumental: z.boolean().nullish(),
  plainLyrics: z.string().nullish(),
  syncedLyrics: z.string().nullish(),
});
type LrclibRecord = z.infer<typeof LrclibRecordSchema>;

/** LRCLIB was unreachable or errored — the result must not be cached. */
export class LyricsUpstreamError extends Error {}

// Bracketed noise commonly found in file names: "(Official Video)", "[Lyrics]", "(Remastered 2011)" ...
const BRACKET_NOISE =
  /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster(ed)?|explicit|clean)\b[^)\]]*[)\]]/gi;
const FEATURING = /\s*[([]?\s*\b(feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]?\s*$/i;
// Album-rip track numbers: "07 ", "1-07 ", "01. ", "12 - " (only when a name follows)
const TRACK_NUMBER = /^\s*\d{1,3}(?:[-.]\d{1,3})?(?:\s*[-.]\s*|\s+)(?=\S)/;

export function cleanPart(part: string): string {
  return part.replace(/_/g, " ").replace(BRACKET_NOISE, "").replace(FEATURING, "").replace(/\s+/g, " ").trim();
}

/** Keep only the primary artist ("A, B" / "A & B" / "A x B" / "A with B") — LRCLIB matches on one artist name */
export const primaryArtist = (artist: string) => cleanPart(artist).split(/\s*(?:,|&|\sx\s|\sand\s|\swith\s)\s*/i)[0];

/**
 * Split "Artist - Title" (hyphen or en/em dash) and strip common file-name noise from each side.
 * A leading album-rip track number ("07 ", "1-07 ") is stripped unless `keepLeadingNumber` is set —
 * callers that can't tell "07 Song" from "50 Cent - Song" should try both.
 */
export function parseTrackName(
  raw: string,
  options: { keepLeadingNumber?: boolean } = {}
): { artist?: string; title: string; query: string } {
  const name = options.keepLeadingNumber ? raw : raw.replace(TRACK_NUMBER, "");
  const [head, ...rest] = name.split(/\s+[-–—]\s+/);
  if (rest.length === 0) {
    const title = cleanPart(head);
    return { title, query: title };
  }
  const artist = primaryArtist(head);
  const title = cleanPart(rest.join(" - "));
  return { artist, title, query: `${artist} ${title}` };
}

const hasLyrics = (record: LrclibRecord) =>
  record.instrumental === true || Boolean(record.syncedLyrics) || Boolean(record.plainLyrics);

function toResponse(record: LrclibRecord | null): LyricsResponseType {
  if (!record || !hasLyrics(record)) return { status: "not_found" };
  const match = { trackName: record.trackName, artistName: record.artistName };
  if (record.instrumental) return { status: "instrumental", match };
  if (record.syncedLyrics) {
    return { status: "synced", syncedLyrics: record.syncedLyrics, plainLyrics: record.plainLyrics ?? undefined, match };
  }
  return { status: "plain", plainLyrics: record.plainLyrics ?? "", match };
}

interface CacheEntry {
  value: LyricsResponseType;
  expiresAt: number;
}

export class LyricsManager {
  private readonly apiUrl = process.env.LYRICS_API_URL ?? DEFAULT_API_URL;
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<LyricsResponseType>>();

  async getLyrics(request: GetLyricsQueryType): Promise<LyricsResponseType> {
    const { track, artist, title, duration } = request;
    const key = [track, artist ?? "", title ?? "", duration ? Math.round(duration) : ""]
      .map((part) => String(part).trim().toLowerCase())
      .join("|");

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // Coalesce concurrent requests (a whole room asks the moment a track starts)
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this.lookup(request)
      .then((value) => {
        this.remember(key, value);
        return value;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    return promise;
  }

  private remember(key: string, value: LyricsResponseType): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(key)) {
      // Map preserves insertion order: evict the oldest entry
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const ttl = value.status === "not_found" ? MISS_TTL_MS : HIT_TTL_MS;
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  private async lookup({ track, artist, title, duration }: GetLyricsQueryType): Promise<LyricsResponseType> {
    // Known song details (tags / music provider) are trusted as-is: exact match, then a search
    if (artist && title) {
      const knownArtist = primaryArtist(artist);
      const knownTitle = cleanPart(title);
      const record =
        (await this.get({ artist: knownArtist, title: knownTitle, duration })) ??
        (await this.search({
          query: `${knownArtist} ${knownTitle}`,
          title: knownTitle,
          duration,
          requireExactTitle: false,
        }));
      if (record) return toResponse(record);
    }

    // Otherwise guess from the display name. "07 Song" and "50 Cent - Song" look alike, so try
    // with the leading number stripped first, then kept.
    const guesses = [parseTrackName(track), parseTrackName(track, { keepLeadingNumber: true })].filter(
      (guess, index, all) =>
        all.findIndex((other) => other.artist === guess.artist && other.title === guess.title) === index
    );

    for (const guess of guesses) {
      if (!guess.artist || !guess.title) continue;
      // Exact match first, then swapped order for files named "Title - Artist"
      const record =
        (await this.get({ artist: guess.artist, title: guess.title, duration })) ??
        (await this.get({ artist: guess.title, title: guess.artist, duration }));
      if (record) return toResponse(record);
    }

    // Without an artist, a title-only search is ambiguous: accept exact titles only, so a
    // file named "Attention" never shows "ATTENTION ATTENTION" by another band
    const [best] = guesses;
    return toResponse(
      await this.search({ query: best.query || track, title: best.title, duration, requireExactTitle: !best.artist })
    );
  }

  private async request(path: string, params: Record<string, string>): Promise<Response | null> {
    const url = new URL(path, this.apiUrl);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new LyricsUpstreamError(`LRCLIB request failed: ${url.pathname}`, { cause: error });
    }

    if (response.status === 404) return null;
    if (!response.ok) throw new LyricsUpstreamError(`LRCLIB ${url.pathname} responded ${response.status}`);
    return response;
  }

  private async get(data: { artist: string; title: string; duration?: number }): Promise<LrclibRecord | null> {
    const params: Record<string, string> = { artist_name: data.artist, track_name: data.title };
    if (data.duration) params.duration = String(Math.round(data.duration));

    const response = await this.request("/api/get", params);
    if (!response) return null;

    const parsed = LrclibRecordSchema.safeParse(await response.json());
    return parsed.success && hasLyrics(parsed.data) ? parsed.data : null;
  }

  private async search({
    query,
    title,
    duration,
    requireExactTitle,
  }: {
    query: string;
    title: string;
    duration?: number;
    requireExactTitle: boolean;
  }): Promise<LrclibRecord | null> {
    const response = await this.request("/api/search", { q: query });
    if (!response) return null;

    const parsed = z.array(LrclibRecordSchema).safeParse(await response.json());
    if (!parsed.success) return null;

    const durationDiff = (record: LrclibRecord) =>
      duration && record.duration ? Math.abs(record.duration - duration) : 0;

    const normalize = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const wantedTitle = normalize(title);
    const exactTitle = (record: LrclibRecord) => Number(normalize(record.trackName) === wantedTitle);

    const candidates = parsed.data.filter(
      (record) =>
        hasLyrics(record) &&
        (!requireExactTitle || exactTitle(record) === 1) &&
        (!duration || (record.duration != null && durationDiff(record) <= DURATION_TOLERANCE_S))
    );

    // Search matches on any field, so "Attention" also finds "ATTENTION ATTENTION": prefer an
    // exact title, then time-synced lyrics, then the closest duration
    candidates.sort(
      (a, b) =>
        exactTitle(b) - exactTitle(a) ||
        Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) ||
        durationDiff(a) - durationDiff(b)
    );
    return candidates[0] ?? null;
  }
}

export const LYRICS_MANAGER = new LyricsManager();
