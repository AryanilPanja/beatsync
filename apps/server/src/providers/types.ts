import type { AudioSourceType, ProviderSearchResultType } from "@beatsync/shared";

/**
 * A music provider backs the search bar. Each adapter maps its own catalog/API to the
 * provider-neutral shapes in @beatsync/shared, so swapping providers needs no UI or
 * protocol changes: add an adapter in this folder and register it in ./index.ts.
 */
export interface MusicProvider {
  readonly name: string;

  /** Search the provider's catalog. `offset` pages through results. */
  search(query: string, offset: number): Promise<ProviderSearchResultType>;

  /**
   * Resolve a search result into a playable queue entry (URL + song details).
   * The URL may be absolute or relative to the API base URL.
   */
  getAudioSource(data: { trackId: string; roomId: string; trackName?: string }): Promise<AudioSourceType>;
}
