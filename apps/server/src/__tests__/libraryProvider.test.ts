// "My Library" provider. Ids end up in queues and state backups, so they must survive a
// re-index; tag-less files must still get a usable title/artist; search ranking decides
// what users see first; and only indexed ids may ever resolve to a file on disk.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryProvider } from "@/providers/library";

/** Minimal ID3v2.3 tag (TIT2/TPE1/TALB, Latin-1) followed by a few padding bytes */
function id3({ title, artist, album }: { title: string; artist: string; album?: string }): Uint8Array {
  const frame = (id: string, text: string) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]);
    const header = Buffer.alloc(10);
    header.write(id, 0, "latin1");
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const frames = Buffer.concat([frame("TIT2", title), frame("TPE1", artist), ...(album ? [frame("TALB", album)] : [])]);
  const size = frames.length;
  const synchsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
  return Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, ...synchsafe]), frames, Buffer.alloc(16)]);
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "beatsync-library-"));
  await mkdir(join(root, "5 Seconds of Summer", "CALM"), { recursive: true });
  await writeFile(
    join(root, "5 Seconds of Summer", "CALM", "05 Teeth.mp3"),
    id3({ title: "Teeth", artist: "5 Seconds of Summer", album: "CALM" })
  );
  await writeFile(join(root, "Teeth Grinder.mp3"), id3({ title: "Teeth Grinder", artist: "Another Band" }));
  await writeFile(join(root, "Grind - Sharp Teeth.mp3"), id3({ title: "Sharp Teeth", artist: "Grind" }));
  // No tags at all: title/artist must come from the file name
  await writeFile(join(root, "03 Some Artist - Untagged Song.mp3"), Buffer.alloc(32));
  await writeFile(join(root, ".hidden.mp3"), Buffer.alloc(32));
  await writeFile(join(root, "notes.txt"), "not audio");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LibraryProvider", () => {
  it("indexes audio files only, skipping hidden files", async () => {
    const library = new LibraryProvider(root);
    await library.index();
    expect(library.size).toBe(4);
  });

  it("keeps the same ids across re-indexing (ids are stored in queues and backups)", async () => {
    const first = new LibraryProvider(root);
    await first.index();
    const second = new LibraryProvider(root);
    await second.index();

    const ids = async (library: LibraryProvider) =>
      (await library.search("teeth", 0)).items.map((item) => item.id).sort();
    expect(await ids(second)).toEqual(await ids(first));
  });

  it("falls back to the file name (minus track number) when a file has no tags", async () => {
    const library = new LibraryProvider(root);
    await library.index();

    const [track] = (await library.search("untagged", 0)).items;
    expect(track).toMatchObject({ title: "Untagged Song", artist: "Some Artist" });
  });

  it("ranks an exact title above title prefixes and partial matches", async () => {
    const library = new LibraryProvider(root);
    await library.index();

    const titles = (await library.search("teeth", 0)).items.map((item) => item.title);
    expect(titles).toEqual(["Teeth", "Teeth Grinder", "Sharp Teeth"]);
  });

  it("resolves a search result to a playable source with its song details", async () => {
    const library = new LibraryProvider(root);
    await library.index();

    const [teeth] = (await library.search("teeth 5 seconds", 0)).items;
    const source = await library.getAudioSource({ trackId: teeth.id });
    expect(source).toMatchObject({
      url: `/library/audio/${teeth.id}`,
      title: "Teeth",
      artist: "5 Seconds of Summer",
      album: "CALM",
    });
    expect(library.getTrackPath(teeth.id)).toEndWith(join("CALM", "05 Teeth.mp3"));
  });

  it("never resolves ids that aren't in the index to a path", async () => {
    const library = new LibraryProvider(root);
    await library.index();

    expect(library.getTrackPath("../../etc/passwd")).toBeUndefined();
    expect(library.getTrackPath("0000000000000000")).toBeUndefined();
    let error: unknown;
    try {
      await library.getAudioSource({ trackId: "../../etc/passwd" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
  });
});
