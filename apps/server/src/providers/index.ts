import { DEFAULT_HIFI_API_URLS, DEFAULT_HIFI_STREAMING_URLS, HifiProvider, parseUrlList } from "@/providers/hifi";
import { LegacyProvider } from "@/providers/legacy";
import { LibraryProvider } from "@/providers/library";
import { SaavnProvider } from "@/providers/saavn";
import type { MusicProvider } from "@/providers/types";
import { homedir } from "os";
import { resolve } from "path";

let provider: MusicProvider | null | undefined;

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

/** The configured music provider (created once, lazily), or null if none is configured. */
export function getMusicProvider(): MusicProvider | null {
  if (provider === undefined) {
    provider = createProvider();
    if (provider) console.log(`🎶 Music provider: ${provider.name}`);
  }
  return provider;
}

/** The library provider, when it is the active provider (used by the /library/* routes). */
export function getLibraryProvider(): LibraryProvider | null {
  const active = getMusicProvider();
  return active instanceof LibraryProvider ? active : null;
}
