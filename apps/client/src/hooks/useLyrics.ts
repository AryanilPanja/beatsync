import { fetchLyrics } from "@/lib/api";
import { parseLrc } from "@/lib/lrc";
import { getTrackDisplay } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * Lyrics for the currently selected track. Known song details (from a music provider or the
 * uploaded file's tags) are sent as artist + title; otherwise the server guesses from the
 * display name. The server proxies LRCLIB and caches per track, so a room shares one lookup.
 */
export function useLyrics() {
  const selectedSource = useGlobalStore(
    (state) => state.audioSources.find((as) => as.source.url === state.selectedAudioUrl) ?? null
  );
  // Duration of the decoded buffer: available as soon as the track is loaded, before it plays
  const decodedDuration = selectedSource?.status === "loaded" ? selectedSource.buffer.duration : 0;
  const roundedDuration = Math.round(decodedDuration || selectedSource?.source.duration || 0);

  const source = selectedSource?.source;
  const display = source ? getTrackDisplay(source) : null;
  const track = display ? (display.artist ? `${display.artist} - ${display.title}` : display.title) : "";
  const artist = source?.title ? source.artist : undefined;
  const title = source?.title && source.artist ? source.title : undefined;

  const query = useQuery({
    queryKey: ["lyrics", track, artist ?? "", title ?? "", roundedDuration],
    queryFn: () => fetchLyrics({ track, artist, title, duration: roundedDuration }),
    enabled: !!track && roundedDuration > 0,
    staleTime: Infinity,
    retry: 1,
  });

  const syncedLyrics = query.data?.status === "synced" ? query.data.syncedLyrics : null;
  const lines = useMemo(() => (syncedLyrics ? parseLrc(syncedLyrics, { keepEmpty: true }) : []), [syncedLyrics]);

  return {
    track,
    displayTitle: display?.title ?? "",
    displayArtist: display?.artist,
    lyrics: query.data,
    lines,
    // Waiting for the buffer to decode counts as loading too
    isLoading: !!track && (roundedDuration === 0 || query.isPending),
    isError: query.isError,
  };
}
