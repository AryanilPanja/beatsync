import type { UploadCompleteType } from "@beatsync/shared";

type UploadMetadata = NonNullable<UploadCompleteType["metadata"]>;

const nonEmpty = (value?: string) => (value?.trim() ? value.trim() : undefined);

/**
 * Read title/artist/album (and duration/ISRC) from an audio file's embedded tags.
 * The parser is loaded only when someone uploads. Never throws: files without readable
 * tags simply upload without song details (the file name is used for display instead).
 */
export async function readAudioTags(file: File): Promise<UploadMetadata | undefined> {
  try {
    const { parseBlob } = await import("music-metadata");
    const { common, format } = await parseBlob(file, { duration: false, skipCovers: true });

    const metadata: UploadMetadata = {
      title: nonEmpty(common.title),
      artist: nonEmpty(common.artist),
      album: nonEmpty(common.album),
      duration: format.duration ? Math.round(format.duration) : undefined,
      isrc: nonEmpty(common.isrc?.[0]),
    };
    return metadata.title ? metadata : undefined;
  } catch (error) {
    console.warn(`Could not read tags from ${file.name}:`, error);
    return undefined;
  }
}
