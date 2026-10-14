// MonochromeProvider: the search API returns a fixed result set (no pagination) and
// durations in milliseconds, both easy to get wrong; stream URLs must resolve with the
// "mono:" prefix stripped and queue entries must keep title/artist/duration/artwork.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { stub, type SinonStub } from "sinon";
import { mockR2 } from "@/__tests__/mocks/r2";
import { MonochromeProvider } from "@/providers/monochrome";

mockR2({
  uploadBytes: mock((bytes: Uint8Array, roomId: string, fileName: string, contentType: string) => {
    uploads.push({ bytes, roomId, fileName, contentType });
    return Promise.resolve(`https://cdn.example.com/room-${roomId}/${fileName}`);
  }),
});

const uploads: { bytes: Uint8Array; roomId: string; fileName: string; contentType: string }[] = [];

const TRACK = {
  id: "159820593456717824",
  trackId: "159820593456717824",
  title: "golden hour",
  artistNames: ["JVKE"],
  artwork: "https://tracks.monochrome.st/proxy/mi/159730397368950784-1A01.jpg",
  explicit: false,
  playable: true,
  duration: 209259,
  isrc: "GBKPL2204171",
};

const SEARCH_BODY = { tracks: [TRACK, { ...TRACK, trackId: "2", title: "golden hour (Cello Version)" }] };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const FLAC_BYTES = new Uint8Array(5);

let fetchStub: SinonStub | null = null;

function mockFetch(routes: (url: URL) => Response | Promise<Response> | "unreachable") {
  fetchStub = stub(globalThis, "fetch");
  fetchStub.callsFake((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const result = routes(url);
    if (result === "unreachable") {
      return Promise.reject(new Error(`connect ECONNREFUSED ${url.origin}`));
    }
    return Promise.resolve(result);
  });
}

beforeEach(() => {
  uploads.length = 0;
});

afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

describe("MonochromeProvider", () => {
  it("maps search results: prefixed ids, ms→s duration, isrc, playable filter", async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(`${url.pathname}${url.search}`);
      return json({ tracks: [TRACK, { ...TRACK, trackId: "3", playable: false, duration: 1000 }] });
    });

    const provider = new MonochromeProvider(["https://tracks.monochrome.st"]);
    const result = await provider.search("golden hour", 0);

    expect(requested[0]).toBe("/search?q=golden+hour");
    expect(result.items).toHaveLength(1); // non-playable tracks are skipped
    expect(result.items[0]).toEqual({
      id: "mono:159820593456717824",
      title: "golden hour",
      artist: "JVKE",
      duration: 209,
      imageUrl: TRACK.artwork,
    });
    expect(result.total).toBe(1);
  });

  it("downloads /track/<id> as FLAC and copies song details into the queue entry", async () => {
    mockFetch((url) => {
      if (url.pathname === "/search") return json(SEARCH_BODY);
      if (url.pathname === "/track/159820593456717824") {
        return new Response(FLAC_BYTES, { status: 200, headers: { "Content-Type": "audio/flac" } });
      }
      return "unreachable";
    });

    const provider = new MonochromeProvider(["https://tracks.monochrome.st"]);
    await provider.search("golden hour", 0);
    const source = await provider.getAudioSource({
      trackId: "159820593456717824",
      roomId: "654321",
    });

    expect(source.url).toMatch(/^https:\/\/cdn\.example\.com\/room-654321\/JVKE - golden hour___.*\.flac$/);
    expect(source.title).toBe("golden hour");
    expect(source.artist).toBe("JVKE");
    expect(source.duration).toBe(209);
    expect(source.imageUrl).toBe(TRACK.artwork);
    expect(source.isrc).toBe("GBKPL2204171");
    expect(uploads[0].contentType).toBe("audio/flac");
    expect(new Uint8Array(uploads[0].bytes)).toEqual(FLAC_BYTES);
  });

  it("fails over to the next instance and reports combined errors", async () => {
    mockFetch((url) => {
      if (url.origin === "https://mono-a.test") return "unreachable";
      if (url.pathname === "/search") return json({ tracks: [TRACK] });
      return "unreachable";
    });

    const provider = new MonochromeProvider(["https://mono-a.test", "https://mono-b.test"]);
    const result = await provider.search("golden hour", 0);
    expect(result.items).toHaveLength(1);

    const dead = new MonochromeProvider(["https://mono-a.test"]);
    const error = await dead.search("x", 0).then(
      () => null,
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/Monochrome search failed/);
  });
});
