import type { MusicProvider } from "@/providers/types";
import type { AudioSourceType, ProviderSearchResultType, ProviderTrackType } from "@beatsync/shared";
import { asError } from "@/providers/failover";

/**
 * Wraps a primary provider (e.g. saavn) with ordered fallbacks (monochrome, invidious,
 * audius). The primary's fuzzy search rarely comes back empty, so fallback results are
 * always merged below the primary's on the first page (capped) — the exact matches from
 * Tidal/YouTube/Audius then appear even when JioSaavn returns loose ones. Later pages
 * come from the primary alone, with the offset shifted so nothing is skipped twice.
 * Stream resolution dispatches on the id prefix so every provider stays addressable.
 */
const FALLBACK_MERGE_LIMIT = 10;

export class CompositeProvider implements MusicProvider {
  /** Report the primary's name — logs and errors stay readable ("Music provider: saavn"). */
  readonly name: string;
  readonly idPrefix: undefined;

  private readonly byPrefix = new Map<string, MusicProvider>();
  /** How many fallback rows were merged into page 0 of a query (shifts later offsets). */
  private readonly mergedCounts = new Map<string, number>();

  constructor(
    private readonly primary: MusicProvider,
    private readonly fallbacks: MusicProvider[]
  ) {
    this.name = primary.name;
    for (const provider of this.fallbacks) {
      if (!provider.idPrefix) {
        console.warn(`CompositeProvider: fallback "${provider.name}" has no idPrefix and is unreachable`);
        continue;
      }
      this.byPrefix.set(provider.idPrefix, provider);
    }
  }

  async search(query: string, offset: number): Promise<ProviderSearchResultType> {
    const errors: string[] = [];

    let fallbackItems: ProviderTrackType[] = [];
    if (offset === 0) {
      for (const provider of this.fallbacks) {
        if (!provider.idPrefix) continue;
        try {
          const result = await provider.search(query, 0);
          fallbackItems.push(...result.items);
          if (result.items.length === 0) errors.push(`${provider.name}: no results`);
        } catch (error) {
          errors.push(`${provider.name}: ${asError(error)}`);
        }
        if (fallbackItems.length >= FALLBACK_MERGE_LIMIT) break;
      }
      fallbackItems = fallbackItems.slice(0, FALLBACK_MERGE_LIMIT);
      this.mergedCounts.set(query, fallbackItems.length);
    }

    const mergedCount = offset === 0 ? fallbackItems.length : (this.mergedCounts.get(query) ?? 0);
    const primaryOffset = Math.max(0, offset - mergedCount);
    let primaryResult: ProviderSearchResultType | null = null;
    try {
      primaryResult = await this.primary.search(query, primaryOffset);
    } catch (error) {
      errors.push(`${this.primary.name}: ${asError(error)}`);
    }

    const items = [...(primaryResult?.items ?? []), ...fallbackItems];
    if (items.length === 0 && errors.length > 0) {
      throw new Error(`No search results: ${errors.join(" | ")}`);
    }
    return {
      items,
      total: (primaryResult?.total ?? 0) + fallbackItems.length,
      offset,
      limit: primaryResult?.limit ?? FALLBACK_MERGE_LIMIT,
    };
  }

  async getAudioSource(data: { trackId: string; roomId: string; trackName?: string }): Promise<AudioSourceType> {
    for (const [prefix, provider] of this.byPrefix) {
      if (data.trackId.startsWith(prefix)) {
        return provider.getAudioSource({ ...data, trackId: data.trackId.slice(prefix.length) });
      }
    }
    return this.primary.getAudioSource(data);
  }
}
