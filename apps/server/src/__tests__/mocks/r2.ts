import { mock } from "bun:test";
import * as realR2 from "@/lib/r2";

/**
 * Default R2 mock that stubs all external R2 operations as no-ops.
 * Call `mockR2()` at the top of your test file (before any imports that use R2).
 *
 * The real module is spread in first, so pure helpers (createKey, generateAudioFileName,
 * getPublicAudioUrl, …) keep working — mock.module is process-wide and would otherwise
 * wipe them for test files that load after a mock is registered (see r2.test.ts).
 *
 * For custom overrides, pass a partial map:
 * ```ts
 * mockR2({ downloadJSON: mock(() => myData) })
 * ```
 */
export function mockR2(overrides: Record<string, ReturnType<typeof mock>> = {}): void {
  const defaults: Record<string, ReturnType<typeof mock>> = {
    deleteObjectsWithPrefix: mock(() => ({ deletedCount: 0 })),
    uploadJSON: mock(() => {
      /* noop */
    }),
    downloadJSON: mock(() => null),
    getLatestFileWithPrefix: mock(() => null),
    getSortedFilesWithPrefix: mock(() => []),
    deleteObject: mock(() => {
      /* noop */
    }),
    validateAudioFileExists: mock(() => true),
    cleanupOrphanedRooms: mock(() => ({
      orphanedRooms: [],
      totalRooms: 0,
      totalFiles: 0,
    })),
  };

  void mock.module("@/lib/r2", () => ({ ...realR2, ...defaults, ...overrides }));
}
