// Restoring rooms after a restart must only HEAD-check files that live in our bucket.
// Library tracks (/library/audio/<id>) and other external URLs can't be found there, and
// used to be silently dropped from every queue on each deploy.

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { BackupManager } from "@/managers/BackupManager";
import { globalManager } from "@/managers/GlobalManager";

const BUCKET_URL = "https://cdn.example.com";

mockR2({
  getLatestFileWithPrefix: mock(() => "state-backup/backup-test.json"),
  // Every bucket file is "missing" for this test
  validateAudioFileExists: mock(() => false),
  downloadJSON: mock(() => ({
    timestamp: Date.now(),
    data: {
      rooms: {
        "restore-sources": {
          clientDatas: [],
          audioSources: [
            { url: `${BUCKET_URL}/room-restore-sources/gone___2025.mp3` },
            { url: "/library/audio/0123456789abcdef", title: "Teeth", artist: "5 Seconds of Summer" },
          ],
          globalVolume: 1,
          playbackState: { type: "paused", audioSource: "", serverTimeToExecute: 0, trackPositionSeconds: 0 },
        },
      },
    },
  })),
});

describe("BackupManager.restoreState audio source validation", () => {
  beforeEach(() => {
    process.env.S3_PUBLIC_URL = BUCKET_URL;
    for (const roomId of globalManager.getRoomIds()) globalManager.deleteRoom(roomId);
  });

  it("drops missing bucket files but keeps library tracks with their song details", async () => {
    await BackupManager.restoreState();

    expect(globalManager.getRoom("restore-sources")?.getAudioSources()).toEqual([
      { url: "/library/audio/0123456789abcdef", title: "Teeth", artist: "5 Seconds of Summer" },
    ]);
    globalManager.getRoom("restore-sources")?.cancelCleanup();
  });
});
