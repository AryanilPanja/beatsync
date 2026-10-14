// InvidiousProvider: instances die constantly, so failover + dead-host cooldown is the
// core behavior; stream choice must prefer itag 140 (AAC, plays everywhere) over Opus,
// and " - Topic" must be stripped from artist names.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { stub, type SinonStub } from "sinon";
import { mockR2 } from "@/__tests__/mocks/r2";
import { InvidiousProvider } from "@/providers/invidious";

mockR2({
  uploadBytes: mock((bytes: Uint8Array, roomId: string, fileName: string, contentType: string) => {
    uploads.push({ bytes, roomId, fileName, contentType });
    return Promise.resolve(`https://cdn.example.com/room-${roomId}/${fileName}`);
  }),
});

const uploads: { bytes: Uint8Array; roomId: string; fileName: string; contentType: string }[] = [];

const VIDEO = {
  type: "video",
  videoId: "PEM0Vs8jf1w",
  title: "JVKE - golden hour (official music video)",
  author: "JVKE",
  lengthSeconds: 232,
  videoThumbnails: [{ url: "https://invidious.f5.si/vi/PEM0Vs8jf1w/maxres.jpg" }],
};

const VIDEO_DETAIL = {
  title: "JVKE - golden hour (official music video)",
  author: "JVKE",
  lengthSeconds: 232,
  adaptiveFormats: [
    { itag: "251", type: "audio/webm; codecs=opus", container: "webm", bitrate: "178696", url: "https://gv.test/opus" },
    {
      itag: "140",
      type: "audio/mp4; codecs=mp4a.40.2",
      container: "m4a",
      bitrate: "131025",
      url: "https://gv.test/m4a",
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AUDIO_BYTES = new Uint8Array(6);

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

describe("InvidiousProvider", () => {
  it("maps search results with prefixed ids and strips ' - Topic' from authors", async () => {
    mockFetch((url) => {
      if (url.pathname === "/api/v1/search") {
        expect(url.searchParams.get("type")).toBe("video");
        return json([
          VIDEO,
          { ...VIDEO, videoId: "abc123", author: "JVKE - Topic", lengthSeconds: 0 },
          { ...VIDEO, videoId: "live1", liveNow: true },
        ]);
      }
      return "unreachable";
    });

    const provider = new InvidiousProvider(["https://invidious.f5.si"]);
    const result = await provider.search("golden hour", 0);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      id: "inv:PEM0Vs8jf1w",
      title: "JVKE - golden hour (official music video)",
      artist: "JVKE",
      duration: 232,
      imageUrl: "https://invidious.f5.si/vi/PEM0Vs8jf1w/maxres.jpg",
    });
    expect(result.items[1].artist).toBe("JVKE");
  });

  it("fails over to the next instance when one is unreachable", async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(url.origin);
      if (url.origin === "https://inv-a.test") return "unreachable";
      if (url.pathname === "/api/v1/search") return json([VIDEO]);
      return "unreachable";
    });

    const provider = new InvidiousProvider(["https://inv-a.test", "https://inv-b.test"]);
    const result = await provider.search("golden hour", 0);
    expect(result.items).toHaveLength(1);
    expect(requested).toEqual(["https://inv-a.test", "https://inv-b.test"]);
  });

  it("prefers itag 140 (AAC) for the download and uses the right content type", async () => {
    mockFetch((url) => {
      if (url.pathname === "/api/v1/videos/PEM0Vs8jf1w") return json(VIDEO_DETAIL);
      if (url.origin === "https://gv.test") {
        expect(url.pathname).toBe("/m4a");
        return new Response(AUDIO_BYTES, { status: 200, headers: { "Content-Type": "audio/mp4" } });
      }
      return "unreachable";
    });

    const provider = new InvidiousProvider(["https://invidious.f5.si"]);
    const source = await provider.getAudioSource({
      trackId: "PEM0Vs8jf1w",
      roomId: "654321",
    });

    expect(source.url).toMatch(
      /^https:\/\/cdn\.example\.com\/room-654321\/JVKE - JVKE - golden hour \(official music video\)___.*\.m4a$/
    );
    expect(source.artist).toBe("JVKE");
    expect(source.duration).toBe(232);
    expect(uploads[0].contentType).toBe("audio/mp4");
  });

  it("falls back to the highest-bitrate stream when itag 140 is missing", async () => {
    mockFetch((url) => {
      if (url.pathname === "/api/v1/videos/PEM0Vs8jf1w") {
        return json({
          ...VIDEO_DETAIL,
          adaptiveFormats: VIDEO_DETAIL.adaptiveFormats.filter((f) => f.itag !== "140"),
        });
      }
      if (url.origin === "https://gv.test") {
        expect(url.pathname).toBe("/opus");
        return new Response(AUDIO_BYTES, { status: 200 });
      }
      return "unreachable";
    });

    const provider = new InvidiousProvider(["https://invidious.f5.si"]);
    await provider.getAudioSource({ trackId: "PEM0Vs8jf1w", roomId: "654321" });
    expect(uploads[0].contentType).toBe("audio/webm");
  });

  it("reports combined errors when every instance fails", async () => {
    mockFetch(() => "unreachable");

    const provider = new InvidiousProvider(["https://inv-a.test"]);
    const error = await provider.search("golden hour", 0).then(
      () => null,
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/Invidious search failed/);
  });
});
