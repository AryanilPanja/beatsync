import { DEFAULT_HIFI_API_URLS, DEFAULT_HIFI_STREAMING_URLS, HifiProvider, parseUrlList } from "@/providers/hifi";
import { LegacyProvider } from "@/providers/legacy";
import { LibraryProvider } from "@/providers/library";
import { MonochromeProvider, DEFAULT_MONOCHROME_API_URLS } from "@/providers/monochrome";
import { InvidiousProvider, DEFAULT_INVIDIOUS_API_URLS } from "@/providers/invidious";
import { AudiusProvider, DEFAULT_AUDIUS_API_URLS } from "@/providers/audius";
import { CompositeProvider } from "@/providers/composite";
import { SaavnProvider } from "@/providers/saavn";
import type { MusicProvider } from "@/providers/types";
import { homedir } from "os";
import { resolve } from "path";

let provider: MusicProvider | null | undefined;
let primary: MusicProvider | null | undefined;

const expandHome = (path: string) =>
  path.startsWith("~") ? resolve(homedir(), path.slice(1).replace(/^\//, "")) : path;

function createProvider(): MusicProvider | null {
  // Explicit MUSIC_PROVIDER wins; otherwise infer from which provider is configured
  const kind =
    process.env.MUSIC_PROVIDER ??
    (process.env.MUSIC_LIBRARY_DIR
      ? "library"
      : process.env.SAAVN_API_URL
        ? "saavn"
        : process.env.HIFI_API_URLS || process.env.HIFI_STREAMING_URLS
          ? "hifi"
          : process.env.PROVIDER_URL
            ? "legacy"
            : undefined);

  switch (kind) {
    case "library": {
      const dir = process.env.MUSIC_LIBRARY_DIR;
      if (!dir) {
        console.error("MUSIC_PROVIDER=library requires MUSIC_LIBRARY_DIR");
        return null;
      }
      const library = new LibraryProvider(resolve(expandHome(dir)));
      library.index().catch((error: unknown) => console.error("Library indexing failed:", error));
      return library;
    }
    case "hifi":
      return new HifiProvider(
        parseUrlList(process.env.HIFI_API_URLS, DEFAULT_HIFI_API_URLS),
        parseUrlList(process.env.HIFI_STREAMING_URLS, DEFAULT_HIFI_STREAMING_URLS)
      );
    case "legacy": {
      const url = process.env.PROVIDER_URL;
      if (!url) {
        console.error("MUSIC_PROVIDER=legacy requires PROVIDER_URL");
        return null;
      }
      return new LegacyProvider(url);
    }
    case "saavn":
      return new SaavnProvider();
    // Register new providers here, e.g. case "myservice": return new MyServiceProvider(...);
    case undefined:
      return null;
    default:
      console.error(`Unknown MUSIC_PROVIDER "${kind}"`);
      return null;
  }
}

/** Ordered fallback providers used when the primary search finds nothing. */
function createFallbacks(): MusicProvider[] {
  const fallbacks: MusicProvider[] = [];
  for (const rawName of (process.env.MUSIC_FALLBACK_PROVIDERS ?? "").split(/[\s,]+/)) {
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    switch (name) {
      case "monochrome":
        fallbacks.push(
          new MonochromeProvider(parseUrlList(process.env.MONOCHROME_API_URLS, DEFAULT_MONOCHROME_API_URLS))
        );
        break;
      case "invidious":
        fallbacks.push(new InvidiousProvider(parseUrlList(process.env.INVIDIOUS_API_URLS, DEFAULT_INVIDIOUS_API_URLS)));
        break;
      case "audius":
        fallbacks.push(new AudiusProvider(parseUrlList(process.env.AUDIUS_API_URLS, DEFAULT_AUDIUS_API_URLS)));
        break;
      default:
        console.error(`Unknown MUSIC_FALLBACK_PROVIDERS entry "${name}"`);
    }
  }
  return fallbacks;
}

/** The configured music provider (created once, lazily), or null if none is configured. */
export function getMusicProvider(): MusicProvider | null {
  if (provider === undefined) {
    primary = createProvider();
    const fallbacks = primary ? createFallbacks() : [];
    provider = primary && fallbacks.length > 0 ? new CompositeProvider(primary, fallbacks) : primary;
    if (provider) {
      const label = fallbacks.length > 0 ? ` (+ fallbacks: ${fallbacks.map((f) => f.name).join(", ")})` : "";
      console.log(`🎶 Music provider: ${provider.name}${label}`);
    }
  }
  return provider;
}

/** The library provider, when it is the active provider (used by the /library/* routes). */
export function getLibraryProvider(): LibraryProvider | null {
  const active = getMusicProvider();
  if (active instanceof LibraryProvider) return active;
  return primary instanceof LibraryProvider ? primary : null;
}
