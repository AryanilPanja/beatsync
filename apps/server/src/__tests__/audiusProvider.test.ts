// AudiusProvider: the stream endpoint is a 302 to a CDN the server must follow, and
// queue metadata comes from /v1/tracks/<id> when search results were not cached first.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { stub, type SinonStub } from "sinon";
import { mockR2 } from "@/__tests__/mocks/r2";
import { AudiusProvider } from "@/providers/audius";

mockR2({
  uploadBytes: mock((bytes: Uint8Array, roomId: string, fileName: string, contentType: string) => {
    uploads.push({ bytes, roomId, fileName, contentType });
    return Promise.resolve(`https://cdn.example.com/room-${roomId}/${fileName}`);
  }),
});

const uploads: { bytes: Uint8Array; roomId: string; fileName: string; contentType: string }[] = [];

const TRACK = {
  id: "Q4o5B",
  title: "golden hour (audius exclusive)",
  duration: 96,
  is_streamable: true,
  user: { name: "suiker" },
  artwork: { "150x150": "https://img.audius.test/150.jpg", "480x480": "https://img.audius.test/480.jpg" },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MP3_BYTES = new Uint8Array(8);

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

describe("AudiusProvider", () => {
  it("maps search results with prefixed ids and prefers larger artwork", async () => {
    mockFetch((url) => {
      if (url.pathname === "/v1/tracks/search") {
        expect(url.searchParams.get("app_name")).toBe("beatsync");
        return json({
          data: [TRACK, { ...TRACK, id: "other", is_streamable: false }, { ...TRACK, id: "del", is_delete: true }],
        });
      }
      return "unreachable";
    });

    const provider = new AudiusProvider(["https://discoveryprovider.audius.co"]);
    const result = await provider.search("golden hour", 0);

    expect(result.items).toEqual([
      {
        id: "aud:Q4o5B",
        title: "golden hour (audius exclusive)",
        artist: "suiker",
        duration: 96,
        imageUrl: "https://img.audius.test/480.jpg",
      },
    ]);
  });

  it("follows the stream redirect and copies song details into the queue entry", async () => {
    mockFetch((url) => {
      if (url.pathname === "/v1/tracks/search") return json({ data: [TRACK] });
      if (url.pathname === "/v1/tracks/Q4o5B/stream") {
        expect(url.searchParams.get("app_name")).toBe("beatsync");
        return new Response(MP3_BYTES, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }
      return "unreachable";
    });

    const provider = new AudiusProvider(["https://discoveryprovider.audius.co"]);
    await provider.search("golden hour", 0);
    const source = await provider.getAudioSource({ trackId: "Q4o5B", roomId: "654321" });

    expect(source.url).toMatch(
      /^https:\/\/cdn\.example\.com\/room-654321\/suiker - golden hour \(audius exclusive\)___.*\.mp3$/
    );
    expect(source.title).toBe("golden hour (audius exclusive)");
    expect(source.artist).toBe("suiker");
    expect(source.duration).toBe(96);
    expect(uploads[0].contentType).toBe("audio/mpeg");
  });

  it("fetches track metadata when resolving a stream without a prior search", async () => {
    let detailCalled = false;
    mockFetch((url) => {
      if (url.pathname === "/v1/tracks/Q4o5B") {
        detailCalled = true;
        return json({ data: TRACK });
      }
      if (url.pathname === "/v1/tracks/Q4o5B/stream") {
        return new Response(MP3_BYTES, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }
      return "unreachable";
    });

    const provider = new AudiusProvider(["https://discoveryprovider.audius.co"]);
    const source = await provider.getAudioSource({ trackId: "Q4o5B", roomId: "654321" });

    expect(detailCalled).toBe(true);
    expect(source.title).toBe("golden hour (audius exclusive)");
    expect(source.artist).toBe("suiker");
  });
});
