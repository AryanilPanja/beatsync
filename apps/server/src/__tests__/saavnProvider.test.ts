// SaavnProvider: JioSaavn's stream URLs are DES-encrypted, so a broken decryptor would
// fail every download silently in dev (search still worked). Pagination offsets are
// absolute but the API is page-based, so a wrong offset skips or duplicates results.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createCipheriv } from "crypto";
import { stub, type SinonStub } from "sinon";
import { mockR2 } from "@/__tests__/mocks/r2";
import { SaavnProvider, decryptMediaUrl, upgradeTo320 } from "@/providers/saavn";

mockR2({
  generateAudioFileName: mock((originalName: string) => `${originalName}___ts`),
  uploadBytes: mock((bytes: Uint8Array, roomId: string, fileName: string, contentType: string) => {
    uploads.push({ bytes, roomId, fileName, contentType });
    return Promise.resolve(`https://cdn.example.com/room-${roomId}/${fileName}`);
  }),
});

const uploads: { bytes: Uint8Array; roomId: string; fileName: string; contentType: string }[] = [];

const DES_KEY = Buffer.from("38346591", "latin1");
const encrypt = (plaintext: string) => {
  const cipher = createCipheriv("des-ecb", DES_KEY, null);
  return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]).toString("base64");
};

const SEARCH_RESULT = {
  id: "urwsaAnP",
  title: "Can We Kiss Forever?",
  subtitle: "Kinà ft. Adriana Proenza - Can We Kiss Forever?",
  perma_url: "https://www.jiosaavn.com/song/can-we-kiss-forever/BRocQhVxWWM",
  image: "https://c.saavncdn.com/213/Can-We-Kiss-Forever-English-2018-20231003051919-150x150.jpg",
  year: "2019",
  language: "english",
  more_info: {
    album: "Can We Kiss Forever?",
    duration: "188",
    "320kbps": "true",
    encrypted_media_url: encrypt("https://aac.saavncdn.com/213/abc_96.mp4"),
    artistMap: {
      primary_artists: [{ id: "1", name: "Kinà", role: "primary_artists" }],
      featured_artists: [{ id: "2", name: "Adriana Proenza", role: "featured_artists" }],
    },
  },
};

const SONG_DETAIL = {
  songs: [
    {
      ...SEARCH_RESULT,
      more_info: {
        ...SEARCH_RESULT.more_info,
        album: "Can We Kiss Forever? (Single)",
        encrypted_media_url: encrypt("https://aac.saavncdn.com/213/abc_96.mp4"),
      },
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AUDIO_BYTES = new Uint8Array(7);

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

describe("SaavnProvider", () => {
  it("decrypts media URLs and upgrades the 96 kbps preview to 320 kbps", () => {
    const decrypted = decryptMediaUrl(encrypt("https://aac.saavncdn.com/213/abc_96.mp4"));
    expect(decrypted).toBe("https://aac.saavncdn.com/213/abc_96.mp4");
    expect(upgradeTo320(decrypted)).toBe("https://aac.saavncdn.com/213/abc_320.mp4");
    expect(upgradeTo320("https://aac.saavncdn.com/213/abc_192.mp4")).toBe("https://aac.saavncdn.com/213/abc_192.mp4");
  });

  it("maps search results (decoded entities, 500x500 artwork, joined artists)", async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(url.toString());
      return json({ total: 110, results: [SEARCH_RESULT] });
    });

    const provider = new SaavnProvider("https://www.jiosaavn.com");
    const result = await provider.search("can we kiss forever", 0);

    expect(requested[0]).toContain("search.getResults");
    expect(requested[0]).toContain("q=can+we+kiss+forever");
    expect(result.items).toEqual([
      {
        id: "BRocQhVxWWM",
        title: "Can We Kiss Forever?",
        artist: "Kinà, Adriana Proenza",
        album: "Can We Kiss Forever?",
        duration: 188,
        imageUrl: "https://c.saavncdn.com/213/Can-We-Kiss-Forever-English-2018-20231003051919-500x500.jpg",
      },
    ]);
    expect(result.total).toBe(110);
  });

  it("pages with absolute offsets (offset 30 → page 1)", async () => {
    mockFetch((url) => {
      expect(url.searchParams.get("p")).toBe("1");
      return json({ total: 110, results: [SEARCH_RESULT] });
    });

    const provider = new SaavnProvider("https://www.jiosaavn.com");
    const result = await provider.search("can we kiss forever", 30);
    expect(result.offset).toBe(30);
  });

  it("downloads the 320 kbps stream and copies song details into the queue entry", async () => {
    mockFetch((url) => {
      if (url.searchParams.get("__call") === "webapi.get") {
        expect(url.searchParams.get("token")).toBe("BRocQhVxWWM");
        return json(SONG_DETAIL);
      }
      if (url.host === "aac.saavncdn.com") {
        expect(url.pathname).toBe("/213/abc_320.mp4");
        return new Response(AUDIO_BYTES, { status: 200, headers: { "Content-Type": "audio/mp4" } });
      }
      return "unreachable";
    });

    const provider = new SaavnProvider("https://www.jiosaavn.com");
    const source = await provider.getAudioSource({
      trackId: "BRocQhVxWWM",
      roomId: "654321",
      trackName: "Kinà - Can We Kiss Forever?",
    });

    expect(source.url).toBe(
      "https://cdn.example.com/room-654321/Kinà, Adriana Proenza - Can We Kiss Forever?_320.m4a___ts"
    );
    expect(source.title).toBe("Can We Kiss Forever?");
    expect(source.artist).toBe("Kinà, Adriana Proenza");
    expect(source.album).toBe("Can We Kiss Forever? (Single)");
    expect(source.duration).toBe(188);
    expect(uploads[0].contentType).toBe("audio/mp4");
    expect(new Uint8Array(uploads[0].bytes)).toEqual(AUDIO_BYTES);
  });

  it("keeps the 96 kbps URL when the track is not 320 kbps", async () => {
    mockFetch((url) => {
      if (url.searchParams.get("__call") === "webapi.get") {
        return json({
          songs: [
            {
              ...SONG_DETAIL.songs[0],
              more_info: { ...SONG_DETAIL.songs[0].more_info, "320kbps": "false" },
            },
          ],
        });
      }
      if (url.host === "aac.saavncdn.com") {
        expect(url.pathname).toBe("/213/abc_96.mp4");
        return new Response(AUDIO_BYTES, { status: 200 });
      }
      return "unreachable";
    });

    const provider = new SaavnProvider("https://www.jiosaavn.com");
    const source = await provider.getAudioSource({ trackId: "BRocQhVxWWM", roomId: "654321" });
    // The 96 kbps request path is asserted inside the fetch mock; the queued file
    // name must not claim 320.
    expect(source.url).not.toContain("_320");
  });

  it("throws for unknown tokens", async () => {
    mockFetch(() => json({ songs: [] }));

    const provider = new SaavnProvider("https://www.jiosaavn.com");
    const error = await provider.getAudioSource({ trackId: "gone", roomId: "654321" }).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Unknown Saavn track/);
  });
});
