// CompositeProvider: fallback must trigger only on empty results (not pollute a working
// primary), primary failures must cascade to fallbacks, and prefixed ids must dispatch
// to the right provider with the prefix stripped — an unprefixed id stays with primary.

import { describe, expect, it, mock } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { CompositeProvider } from "@/providers/composite";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType } from "@beatsync/shared";

mockR2();

const RESULT: ProviderSearchResultType = {
  items: [{ id: "t1", title: "Song", artist: "Artist", duration: 100 }],
  total: 1,
  offset: 0,
  limit: 1,
};

const SOURCE: AudioSourceType = { url: "https://cdn.test/x.mp3" };

function fakeProvider(
  name: string,
  options: {
    idPrefix?: string;
    search?: (query: string, offset: number) => Promise<ProviderSearchResultType>;
    getAudioSource?: (trackId: string) => Promise<AudioSourceType>;
  } = {}
): MusicProvider {
  const search = options.search ?? (() => Promise.resolve({ items: [], total: 0, offset: 0, limit: 0 }));
  return {
    name,
    ...(options.idPrefix ? { idPrefix: options.idPrefix } : {}),
    search: mock(search),
    getAudioSource: (data) =>
      Promise.resolve(options.getAudioSource?.(data.trackId) ?? { ...SOURCE, url: `https://cdn.test/${name}` }),
  };
}

describe("CompositeProvider", () => {
  it("merges fallback results below the primary's on the first page", async () => {
    const primary = fakeProvider("saavn", {
      search: () => Promise.resolve({ ...RESULT, total: 27692, limit: 30 }),
    });
    const fallback = fakeProvider("monochrome", {
      idPrefix: "mono:",
      search: () => Promise.resolve({ ...RESULT, items: [{ ...RESULT.items[0], id: "mono:id1" }] }),
    });
    const composite = new CompositeProvider(primary, [fallback]);

    const result = await composite.search("song", 0);
    expect(result.items.map((i) => i.id)).toEqual(["t1", "mono:id1"]);
    expect(result.total).toBe(27693);
    expect(result.offset).toBe(0);
  });

  it("shifts later-page offsets by the merged fallback count and skips fallbacks there", async () => {
    let primaryOffset = -1;
    const primary = fakeProvider("saavn", {
      search: (_query, offset) => {
        primaryOffset = offset;
        return Promise.resolve(RESULT);
      },
    });
    const fallback = fakeProvider("monochrome", {
      idPrefix: "mono:",
      search: () => Promise.resolve({ ...RESULT, items: [{ ...RESULT.items[0], id: "mono:id1" }] }),
    });
    const composite = new CompositeProvider(primary, [fallback]);

    await composite.search("song", 0); // page 0 merges 1 fallback row
    const result = await composite.search("song", 30); // client's next offset: 30 primary + 1 fallback
    expect(primaryOffset).toBe(29);
    expect(result.offset).toBe(30);
    expect(result.items.map((i) => i.id)).toEqual(["t1"]); // fallbacks only merge on page 0
  });

  it("still surfaces fallback results when the primary throws", async () => {
    const failing = fakeProvider("saavn", { search: () => Promise.reject(new Error("down")) });
    const fallback = fakeProvider("monochrome", {
      idPrefix: "mono:",
      search: () => Promise.resolve({ ...RESULT, items: [{ ...RESULT.items[0], id: "mono:id1" }] }),
    });
    const composite = new CompositeProvider(failing, [fallback]);

    const result = await composite.search("song", 0);
    expect(result.items.map((i) => i.id)).toEqual(["mono:id1"]);
  });

  it("throws a combined error only when nothing anywhere returns results", async () => {
    const failing = fakeProvider("saavn", { search: () => Promise.reject(new Error("down")) });
    const fallback = fakeProvider("monochrome", { idPrefix: "mono:" });
    const composite = new CompositeProvider(failing, [fallback]);
    const error = await composite.search("song", 0).then(
      () => null,
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/No search results: monochrome: no results \| saavn: down/);
  });

  it("dispatches prefixed ids to the owning provider with the prefix stripped", async () => {
    let receivedId: string | undefined;
    const monochrome = fakeProvider("monochrome", {
      idPrefix: "mono:",
      getAudioSource: (trackId) => {
        receivedId = trackId;
        return Promise.resolve({ ...SOURCE, url: `https://cdn.test/mono/${trackId}` });
      },
    });
    const primary = fakeProvider("saavn", {
      getAudioSource: (trackId) => Promise.resolve({ ...SOURCE, url: `https://cdn.test/saavn/${trackId}` }),
    });
    const composite = new CompositeProvider(primary, [monochrome]);

    const mono = await composite.getAudioSource({ trackId: "mono:123456", roomId: "r" });
    expect(receivedId).toBe("123456");
    expect(mono.url).toBe("https://cdn.test/mono/123456");

    const saavn = await composite.getAudioSource({ trackId: "BRocQhVxWWM", roomId: "r" });
    expect(saavn.url).toBe("https://cdn.test/saavn/BRocQhVxWWM");
  });

  it("keeps the primary's name and treats prefix-less fallbacks as primary-bound", async () => {
    const primary = fakeProvider("saavn");
    const prefixless = fakeProvider("weird");
    const composite = new CompositeProvider(primary, [prefixless]);
    expect(composite.name).toBe("saavn");
    const source = await composite.getAudioSource({ trackId: "anything", roomId: "r" });
    expect(source.url).toBe("https://cdn.test/saavn");
  });
});
