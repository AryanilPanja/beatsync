import { getCurrentLineIndex, type LrcLine } from "@/lib/lrc";
import { getFilteredOutputLatencyMs, useGlobalStore } from "@/store/global";
import { useEffect, useState } from "react";

/**
 * Index of the lyric line at the current playback position (-1 before the first line).
 * Track position is already synchronized across devices, so every device highlights the
 * same line. While playing it is polled every animation frame; React state only changes
 * when the line changes.
 */
export function useCurrentLyricLine(lines: LrcLine[]): number {
  const isPlaying = useGlobalStore((state) => state.isPlaying);
  const pausedTime = useGlobalStore((state) => state.currentTime);
  const [playingIndex, setPlayingIndex] = useState(-1);

  useEffect(() => {
    if (!isPlaying || lines.length === 0) return;

    // Playback is started early by the output latency so sound leaves the speaker on time;
    // subtract it so the highlight follows what is heard, not what entered the audio pipeline.
    const outputLatencySeconds = getFilteredOutputLatencyMs() / 1000;
    let lastIndex = Number.NaN;
    let frame = 0;

    const tick = () => {
      const position = useGlobalStore.getState().getCurrentTrackPosition() - outputLatencySeconds;
      const index = getCurrentLineIndex({ lines, timeSeconds: position });
      if (index !== lastIndex) {
        lastIndex = index;
        setPlayingIndex(index);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, lines]);

  return isPlaying ? playingIndex : getCurrentLineIndex({ lines, timeSeconds: pausedTime });
}
