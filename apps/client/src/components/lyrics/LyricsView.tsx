"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentLyricLine } from "@/hooks/useCurrentLyricLine";
import { useLyrics } from "@/hooks/useLyrics";
import type { LrcLine } from "@/lib/lrc";
import { cn } from "@/lib/utils";
import { useCanMutate, useGlobalStore } from "@/store/global";
import { MicVocal } from "lucide-react";
import { useEffect, useRef } from "react";

type Variant = "panel" | "fullscreen";

// After the user scrolls by hand, leave them alone for a moment before re-centering
const MANUAL_SCROLL_GRACE_MS = 3000;

const seekTo = (timeSeconds: number) => {
  const { isPlaying, broadcastPlay } = useGlobalStore.getState();
  // Same semantics as the player's seek slider
  if (isPlaying) {
    broadcastPlay(timeSeconds);
  } else {
    useGlobalStore.setState({ currentTime: timeSeconds });
  }
};

const Message = ({ variant, children }: { variant: Variant; children: React.ReactNode }) => (
  <div
    className={cn(
      "flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400",
      variant === "fullscreen" ? "text-lg" : "text-sm"
    )}
  >
    <MicVocal className={cn("text-neutral-600", variant === "fullscreen" ? "size-10" : "size-6")} />
    {children}
  </div>
);

const Attribution = () => (
  <p className="pt-8 pb-4 text-[11px] text-neutral-600">
    Lyrics provided by{" "}
    <a href="https://lrclib.net" target="_blank" rel="noreferrer" className="underline hover:text-neutral-400">
      LRCLIB
    </a>
  </p>
);

const SyncedLyrics = ({ lines, variant }: { lines: LrcLine[]; variant: Variant }) => {
  const canMutate = useCanMutate();
  const currentIndex = useCurrentLyricLine(lines);
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const lastManualScrollRef = useRef(0);

  // Keep the current line centered (scroll only this container, never the page)
  useEffect(() => {
    const container = containerRef.current;
    const line = lineRefs.current[Math.max(currentIndex, 0)];
    if (!container || !line) return;
    if (Date.now() - lastManualScrollRef.current < MANUAL_SCROLL_GRACE_MS) return;

    container.scrollTo({
      top: line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2,
      behavior: "smooth",
    });
  }, [currentIndex]);

  const markManualScroll = () => {
    lastManualScrollRef.current = Date.now();
  };

  const isFullscreen = variant === "fullscreen";

  return (
    <div
      ref={containerRef}
      onWheel={markManualScroll}
      onTouchMove={markManualScroll}
      className={cn(
        "relative h-full overflow-y-auto overscroll-contain",
        isFullscreen ? "px-6 py-[30vh] md:px-16" : "px-4 py-[40%]"
      )}
    >
      {lines.map((line, index) => {
        const isCurrent = index === currentIndex;
        return (
          <p
            key={`${line.time}-${index}`}
            ref={(el) => {
              lineRefs.current[index] = el;
            }}
            onClick={canMutate ? () => seekTo(line.time) : undefined}
            className={cn(
              "origin-left font-bold tracking-tight whitespace-pre-line transition-all duration-300",
              isFullscreen ? "py-3 text-3xl leading-tight md:text-5xl" : "py-2 text-lg leading-snug",
              isCurrent ? "scale-[1.03] text-white" : index < currentIndex ? "text-neutral-500" : "text-neutral-400/70",
              canMutate && "cursor-pointer hover:text-neutral-200"
            )}
          >
            {line.text || "♪"}
          </p>
        );
      })}
      <Attribution />
    </div>
  );
};

export const LyricsView = ({ variant = "panel" }: { variant?: Variant }) => {
  const { track, lyrics, lines, isLoading, isError } = useLyrics();

  if (!track) {
    return <Message variant={variant}>Play a track to see its lyrics</Message>;
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-6">
        {[80, 60, 72, 50, 66].map((width) => (
          <Skeleton key={width} className="h-5 bg-neutral-800" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }

  if (isError || !lyrics) {
    return <Message variant={variant}>Couldn&apos;t load lyrics right now</Message>;
  }

  switch (lyrics.status) {
    case "synced":
      return <SyncedLyrics lines={lines} variant={variant} />;
    case "plain":
      return (
        <div className={cn("h-full overflow-y-auto", variant === "fullscreen" ? "px-6 py-16 md:px-16" : "p-4")}>
          <p className="mb-4 text-xs text-neutral-500">These lyrics aren&apos;t time-synced</p>
          <p
            className={cn(
              "font-semibold whitespace-pre-line text-neutral-200",
              variant === "fullscreen" ? "text-2xl leading-relaxed md:text-3xl" : "text-base leading-relaxed"
            )}
          >
            {lyrics.plainLyrics}
          </p>
          <Attribution />
        </div>
      );
    case "instrumental":
      return <Message variant={variant}>♪ Instrumental</Message>;
    case "not_found":
      return (
        <Message variant={variant}>
          No lyrics found for <span className="font-medium text-neutral-200">&ldquo;{track}&rdquo;</span>
        </Message>
      );
  }
};
