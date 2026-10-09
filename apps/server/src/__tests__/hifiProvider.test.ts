// HifiProvider: the instance pool is community-hosted and flaky by nature, so search
// and stream resolution must fail over to the next instance (a dead instance would
// otherwise silently empty the search bar). Song details cached from search must reach
// the queue entry, and "50 Cent" must not lose its leading token in the file name.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { stub, type SinonStub } from "sinon";
import { mockR2 } from "@/__tests__/mocks/r2";
import { HifiProvider, tidalArtworkUrl } from "@/providers/hifi";

mockR2({
  generateAudioFileName: mock((originalName: string) => `${originalName}___ts`),
  uploadBytes: mock((bytes: Uint8Array, roomId: string, fileName: string, contentType: string) => {
    uploads.push({ bytes, roomId, fileName, contentType });
    return Promise.resolve(`https://cdn.example.com/room-${roomId}/${fileName}`);
  }),
});

const uploads: { bytes: Uint8Array; roomId: string; fileName: string; contentType: string }[] = [];

const TIDAL_TRACK = {
  id: 123456,
  title: "In Da Club",
  version: null,
  duration: 260,
  isrc: "USIR20200462",
  artist: { name: "50 Cent", id: 1 },
  artists: [{ name: "50 Cent", id: 1 }],
  album: {
    id: 10,
    title: "Get Rich or Die Tryin'",
    cover: "5a2d656d-f965-48ba-a241-bce5ad432015",
  },
};

const hifiSearchBody = {
  version: "2.6",
  data: {
    limit: 25,
    offset: 0,
    totalNumberOfItems: 1,
    items: [TIDAL_TRACK],
  },
};

const btsManifest = (url: string, mimeType = "audio/flac") => ({
  version: "2.0",
  data: {
    trackId: 123456,
    manifestMimeType: "application/vnd.tidal.bts",
    manifest: Buffer.from(JSON.stringify({ mimeType, codecs: "flac", encryptionType: "NONE", urls: [url] })).toString(
      "base64"
    ),
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AUDIO_BYTES = new Uint8Array([1, 2, 3]);

let fetchStub: SinonStub | null = null;

/** Route fake responses by origin+pathname; unhandled requests throw like a dead host. */
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

describe("HifiProvider", () => {
  it("maps hifi-api search results to provider-neutral items with absolute artwork", async () => {
    const searchPaths: string[] = [];
    mockFetch((url) => {
      searchPaths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/search/") return json(hifiSearchBody);
      return "unreachable";
    });

    const provider = new HifiProvider(["https://api-a.test"], ["https://stream-a.test"]);
    const result = await provider.search("50 cent", 0);

    expect(searchPaths[0]).toBe("/search/?s=50+cent&offset=0&limit=25");
    expect(result.items).toEqual([
      {
        id: "123456",
        title: "In Da Club",
        artist: "50 Cent",
        album: "Get Rich or Die Tryin'",
        duration: 260,
        imageUrl: tidalArtworkUrl("5a2d656d-f965-48ba-a241-bce5ad432015"),
      },
    ]);
    expect(result.items[0].imageUrl).toBe(
      "https://resources.tidal.com/images/5a2d656d/f965/48ba/a241/bce5ad432015/640x640.jpg"
    );
    expect(result.total).toBe(1);
  });

  it("fails over to the next API instance, then to the legacy Qobuz-proxy shape", async () => {
    mockFetch((url) => {
      if (url.origin === "https://api-a.test") return "unreachable";
      if (url.pathname === "/search/") return json({}, 404);
      if (url.origin === "https://api-b.test" && url.pathname === "/api/search") {
        return json({
          data: {
            tracks: {
              total: 1,
              offset: 0,
              limit: 25,
              items: [
                {
                  id: 789,
                  title: "Teeth",
                  version: null,
                  duration: 213,
                  track_number: 5,
                  parental_warning: false,
                  isrc: "GBAHT2000437",
                  performer: { name: "5 Seconds of Summer", id: 2 },
                  album: {
                    id: "20",
                    title: "CALM",
                    duration: 213,
                    parental_warning: false,
                    release_date_original: "2020-03-27",
                    image: {
                      thumbnail: "https://cdn.test/thumb.jpg",
                      small: "https://cdn.test/small.jpg",
                      large: "https://cdn.test/large.jpg",
                    },
                    artists: [{ id: 2, name: "5 Seconds of Summer", roles: ["Main"] }],
                  },
                },
              ],
            },
          },
        });
      }
      return "unreachable";
    });

    const provider = new HifiProvider(["https://api-a.test", "https://api-b.test"], ["https://stream-a.test"]);
    const result = await provider.search("5sos", 0);

    expect(result.items).toEqual([
      {
        id: "789",
        title: "Teeth",
        artist: "5 Seconds of Summer",
        album: "CALM",
        duration: 213,
        imageUrl: "https://cdn.test/thumb.jpg",
      },
    ]);
  });

  it("throws a combined error when every API instance fails", async () => {
    mockFetch(() => "unreachable");

    const provider = new HifiProvider(["https://api-a.test"], ["https://stream-a.test"]);
    const error = await provider.search("50 cent", 0).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/All music API instances failed/);
  });

  it("resolves a stream via the manifest, uploads into the room folder, and keeps song details", async () => {
    mockFetch((url) => {
      if (url.pathname === "/search/") return json(hifiSearchBody);
      if (url.origin === "https://stream-a.test" && url.pathname === "/track/") {
        expect(url.searchParams.get("id")).toBe("123456");
        expect(url.searchParams.get("quality")).toBe("LOSSLESS");
        return json(btsManifest("https://audio.tidal.test/track.flac"));
      }
      if (url.origin === "https://audio.tidal.test") {
        return new Response(AUDIO_BYTES, { status: 200, headers: { "Content-Type": "audio/flac" } });
      }
      return "unreachable";
    });

    const provider = new HifiProvider(["https://api-a.test"], ["https://stream-a.test"]);
    await provider.search("50 cent", 0);
    const source = await provider.getAudioSource({
      trackId: "123456",
      roomId: "654321",
      trackName: "50 Cent - In Da Club",
    });

    expect(source.url).toBe("https://cdn.example.com/room-654321/50 Cent - In Da Club.flac___ts");
    expect(source.title).toBe("In Da Club");
    expect(source.artist).toBe("50 Cent");
    expect(source.album).toBe("Get Rich or Die Tryin'");
    expect(source.duration).toBe(260);
    expect(source.isrc).toBe("USIR20200462");
    expect(uploads[0].contentType).toBe("audio/flac");
  });

  it("fails over to the next streaming instance when one queues the request (202)", async () => {
    mockFetch((url) => {
      if (url.pathname === "/info/") return json({ data: TIDAL_TRACK });
      if (url.origin === "https://stream-a.test") return json({ status: "pending" }, 202);
      if (url.origin === "https://stream-b.test" && url.pathname === "/track/") {
        return json(btsManifest("https://audio.tidal.test/track.flac"));
      }
      if (url.origin === "https://audio.tidal.test") {
        return new Response(AUDIO_BYTES, { status: 200 });
      }
      return "unreachable";
    });

    const provider = new HifiProvider(["https://api-a.test"], ["https://stream-a.test", "https://stream-b.test"]);
    const source = await provider.getAudioSource({ trackId: "123456", roomId: "654321" });

    expect(source.url).toContain("room-654321");
    expect(source.title).toBe("In Da Club");
  });

  it("falls back to trackName when no metadata is available anywhere", async () => {
    mockFetch((url) => {
      if (url.pathname === "/info/") return json({}, 404);
      if (url.pathname === "/track/") {
        return json(btsManifest("https://audio.tidal.test/track.mp3", "audio/mpeg"));
      }
      if (url.origin === "https://audio.tidal.test") return new Response(AUDIO_BYTES, { status: 200 });
      return "unreachable";
    });

    const provider = new HifiProvider(["https://api-a.test"], ["https://stream-a.test"]);
    const source = await provider.getAudioSource({
      trackId: "123456",
      roomId: "654321",
      trackName: "50 Cent - In Da Club",
    });

    expect(source.title).toBe("50 Cent - In Da Club");
    expect(source.url).toContain("50 Cent - In Da Club.mp3");
  });
});
