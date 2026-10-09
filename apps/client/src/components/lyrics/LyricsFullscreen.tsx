"use client";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useLyrics } from "@/hooks/useLyrics";
import { LyricsView } from "./LyricsView";

export const LyricsFullscreen = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const { displayTitle, displayArtist } = useLyrics();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none border-0 bg-neutral-950/95 p-0 backdrop-blur-xl sm:max-w-none">
        <div className="shrink-0 border-b border-neutral-800/50 px-6 py-4 pr-12 md:px-16">
          <DialogTitle className="truncate text-base text-white">{displayTitle || "Lyrics"}</DialogTitle>
          <DialogDescription className="truncate text-xs text-neutral-500">
            {displayArtist ?? "Lyrics"}
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1">
          <LyricsView variant="fullscreen" />
        </div>
      </DialogContent>
    </Dialog>
  );
};
