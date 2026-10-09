// Lyrics lookup against LRCLIB. A wrong match or a bad cache decision is silent in dev
// (lyrics just look "off" or never appear) but shows up in every room in prod, so pin
// down the matching order, the duration-based choice, and what is / isn't cached.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { LyricsManager, LyricsUpstreamError, parseTrackName } from "@/managers/LyricsManager";

const realFetch = globalThis.fetch;
let requests: URL[];

const record = (overrides: Record<string, unknown> = {}) => ({
  trackName: "Bohemian Rhapsody",
  artistName: "Queen",
  duration: 355,
  instrumental: false,
  plainLyrics: "Is this the real life?",
  syncedLyrics: "[00:00.15] Is this the real life?",
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Route mocked LRCLIB responses by endpoint; each handler sees the request URL. */
function mockLrclib(handler: (url: URL) => Response | Promise<Response>) {
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
}

describe("parseTrackName", () => {
  it("splits artist and title and strips file-name noise", () => {
    expect(parseTrackName("Queen - Bohemian Rhapsody (Official Video)")).toEqual({
      artist: "Queen",
      title: "Bohemian Rhapsody",
      query: "Queen Bohemian Rhapsody",
    });
  });

  it("keeps only the primary artist and drops featured artists", () => {
    expect(parseTrackName("Daft Punk, Pharrell Williams - Get Lucky (feat. Nile Rodgers)")).toMatchObject({
      artist: "Daft Punk",
      title: "Get Lucky",
    });
  });

  it("strips album-rip track numbers so they aren't sent as part of the artist", () => {
    expect(parseTrackName("1-07 Eminem - Rap God")).toMatchObject({ artist: "Eminem", title: "Rap God" });
    expect(parseTrackName("20 Eminem - Not Afraid")).toMatchObject({ artist: "Eminem", title: "Not Afraid" });
    expect(parseTrackName("06 Nice to Meet Ya")).toMatchObject({ title: "Nice to Meet Ya" });
    expect(parseTrackName("12 The Vamps with Matoma - All Night")).toMatchObject({ artist: "The Vamps" });
  });

  it("treats a name without a separator as the title only", () => {
    expect(parseTrackName("some_untitled_track")).toEqual({
      title: "some untitled track",
      query: "some untitled track",
    });
  });
});

describe("LyricsManager", () => {
  let manager: LyricsManager;

  beforeEach(() => {
    requests = [];
    manager = new LyricsManager();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("uses an exact /api/get match with artist, title and rounded duration", async () => {
    mockLrclib(() => json(record()));

    const result = await manager.getLyrics({ track: "Queen - Bohemian Rhapsody", duration: 354.6 });

    expect(result.status).toBe("synced");
    expect(requests).toHaveLength(1);
    expect(requests[0].pathname).toBe("/api/get");
    expect(requests[0].searchParams.get("artist_name")).toBe("Queen");
    expect(requests[0].searchParams.get("track_name")).toBe("Bohemian Rhapsody");
    expect(requests[0].searchParams.get("duration")).toBe("355");
  });

  it("uses known artist/title (from tags or a provider) verbatim, even when the file name has no artist", async () => {
    mockLrclib(() => json(record({ trackName: "Teeth", artistName: "5 Seconds of Summer" })));

    const result = await manager.getLyrics({
      track: "05 Teeth",
      artist: "5 Seconds of Summer",
      title: "Teeth",
      duration: 202,
    });

    expect(result).toMatchObject({ status: "synced", match: { trackName: "Teeth" } });
    expect(requests[0].pathname).toBe("/api/get");
    expect(requests[0].searchParams.get("artist_name")).toBe("5 Seconds of Summer");
    expect(requests[0].searchParams.get("track_name")).toBe("Teeth");
  });

  it("also tries the name with its leading number kept, for artists like '50 Cent'", async () => {
    mockLrclib((url) => (url.searchParams.get("artist_name") === "50 Cent" ? json(record()) : json({}, 404)));

    const result = await manager.getLyrics({ track: "50 Cent - In Da Club", duration: 193 });

    expect(result.status).toBe("synced");
    expect(requests.map((u) => u.searchParams.get("artist_name"))).toContain("50 Cent");
  });

  it("retries /api/get with artist and title swapped for 'Title - Artist' file names", async () => {
    mockLrclib((url) => (url.searchParams.get("artist_name") === "Queen" ? json(record()) : json({}, 404)));

    const result = await manager.getLyrics({ track: "Bohemian Rhapsody - Queen", duration: 355 });

    expect(result.status).toBe("synced");
    expect(requests.map((u) => u.searchParams.get("artist_name"))).toEqual(["Bohemian Rhapsody", "Queen"]);
  });

  it("falls back to search and prefers synced lyrics within the duration tolerance over a closer plain match", async () => {
    mockLrclib((url) => {
      if (url.pathname === "/api/get") return json({}, 404);
      return json([
        record({ duration: 355, syncedLyrics: null, plainLyrics: "plain, exact duration" }),
        record({ duration: 357, syncedLyrics: "[00:01.00] synced, 2s off" }),
        record({ duration: 380, syncedLyrics: "[00:01.00] synced, way off" }),
      ]);
    });

    const result = await manager.getLyrics({ track: "Queen - Bohemian Rhapsody", duration: 355 });

    expect(result).toMatchObject({ status: "synced", syncedLyrics: "[00:01.00] synced, 2s off" });
    expect(requests[requests.length - 1].pathname).toBe("/api/search");
  });

  it("prefers an exact title over a synced partial match when only the title is known", async () => {
    mockLrclib(() =>
      json([
        record({ trackName: "ATTENTION ATTENTION", artistName: "Shinedown", duration: 211 }),
        record({ trackName: "Attention", artistName: "Charlie Puth", duration: 212, syncedLyrics: null }),
      ])
    );

    const result = await manager.getLyrics({ track: "Attention", duration: 211 });

    expect(result).toMatchObject({ status: "plain", match: { artistName: "Charlie Puth" } });
  });

  it("returns not_found rather than a partial-title match when the file name has no artist", async () => {
    mockLrclib(() => json([record({ trackName: "ATTENTION ATTENTION", artistName: "Shinedown", duration: 231 })]));

    expect((await manager.getLyrics({ track: "Attention", duration: 232 })).status).toBe("not_found");
  });

  it("caches a not-found result instead of hitting LRCLIB again", async () => {
    mockLrclib((url) => (url.pathname === "/api/search" ? json([]) : json({}, 404)));

    expect((await manager.getLyrics({ track: "Nobody - Nothing", duration: 100 })).status).toBe("not_found");
    const callsAfterFirst = requests.length;
    expect((await manager.getLyrics({ track: "Nobody - Nothing", duration: 100 })).status).toBe("not_found");
    expect(requests.length).toBe(callsAfterFirst);
  });

  it("does not cache upstream failures, so a later request can succeed", async () => {
    let overloaded = true;
    mockLrclib(() => (overloaded ? json({ message: "overloaded" }, 503) : json(record())));

    let error: unknown;
    try {
      await manager.getLyrics({ track: "Queen - Bohemian Rhapsody", duration: 355 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LyricsUpstreamError);

    overloaded = false;
    expect((await manager.getLyrics({ track: "Queen - Bohemian Rhapsody", duration: 355 })).status).toBe("synced");
  });

  it("shares one upstream lookup between concurrent requests for the same track", async () => {
    mockLrclib(() => json(record()));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => manager.getLyrics({ track: "Queen - Bohemian Rhapsody", duration: 355 }))
    );

    expect(results.every((r) => r.status === "synced")).toBe(true);
    expect(requests).toHaveLength(1);
  });
});
