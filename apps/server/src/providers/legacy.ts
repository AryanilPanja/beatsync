import { generateAudioFileName, uploadBytes } from "@/lib/r2";
import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType, TrackType } from "@beatsync/shared";
import { RawSearchResponseSchema, SearchParamsSchema, StreamResponseSchema, TrackParamsSchema } from "@beatsync/shared";

/** "Artist 1, Artist 2" from the performer plus any distinct album artists */
function formatArtists(track: TrackType): string {
  const artists = [track.performer.name];
  for (const artist of track.album.artists ?? []) {
    if (!artists.includes(artist.name)) artists.push(artist.name);
  }
  return artists.join(", ");
}

/**
 * The original external provider configured with PROVIDER_URL (`/api/search`, `/api/track`).
 * Tracks are downloaded once and copied into the room's storage folder.
 */
export class LegacyProvider implements MusicProvider {
  readonly name = "legacy";

  constructor(private readonly providerUrl: string) {}

  async search(query: string, offset: number): Promise<ProviderSearchResultType> {
    const { q, offset: validOffset } = SearchParamsSchema.parse({ q: query, offset });

    const searchUrl = new URL("/api/search", this.providerUrl);
    searchUrl.searchParams.set("q", q);
    searchUrl.searchParams.set("offset", validOffset.toString());

    const response = await fetch(searchUrl);
    if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);

    const { tracks } = RawSearchResponseSchema.parse(await response.json()).data;
    return {
      items: tracks.items.map((track) => ({
        id: String(track.id),
        title: track.title,
        artist: formatArtists(track),
        album: track.album.title,
        duration: track.duration,
        imageUrl: track.album.image.thumbnail || track.album.image.small,
        version: track.version ?? undefined,
      })),
      total: tracks.total,
      offset: tracks.offset,
      limit: tracks.limit,
    };
  }

  async getAudioSource({
    trackId,
    roomId,
    trackName,
  }: {
    trackId: string;
    roomId: string;
    trackName?: string;
  }): Promise<AudioSourceType> {
    const { id } = TrackParamsSchema.parse({ id: Number(trackId) });

    const streamUrl = new URL("/api/track", this.providerUrl);
    streamUrl.searchParams.set("id", id.toString());
    const streamResponse = await fetch(streamUrl);
    if (!streamResponse.ok) throw new Error(`Stream lookup failed: HTTP ${streamResponse.status}`);

    const stream = StreamResponseSchema.parse(await streamResponse.json());
    if (!stream.success) throw new Error("Failed to get stream URL");

    console.log(`Downloading audio from: ${stream.data.url}`);
    const audio = await fetch(stream.data.url);
    if (!audio.ok) throw new Error(`Failed to download audio: ${audio.status}`);

    const fileName = generateAudioFileName(`${trackName ?? `track-${trackId}`}.mp3`);
    const contentType = audio.headers.get("content-type") ?? "audio/mpeg";
    console.log(`Uploading to storage: room-${roomId}/${fileName}`);
    const url = await uploadBytes(await audio.arrayBuffer(), roomId, fileName, contentType);

    return { url };
  }
}
