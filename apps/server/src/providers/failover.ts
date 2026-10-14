export function parseUrlList(value: string | undefined, fallback: string[]): string[] {
  const list = (value ?? "")
    .split(/[\s,]+/)
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

export function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Errors that mean a host is unreachable right now (bad DNS, refused/reset TLS, timeout). */
export function isDeadHostError(error: unknown): boolean {
  const message = asError(error).toLowerCase();
  return (
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("eai_again") ||
    message.includes("unexpected eof") ||
    message.includes("abort") ||
    message.includes("timeout")
  );
}

/**
 * Community instances come and go; once a host fails at the connection level it is
 * skipped for a cooldown window instead of stalling every search with retries.
 */
export class DeadHostTracker {
  private readonly deadUntil = new Map<string, number>();

  constructor(private readonly cooldownMs: number = 5 * 60_000) {}

  isDown(base: string): boolean {
    const until = this.deadUntil.get(base);
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.deadUntil.delete(base);
      return false;
    }
    return true;
  }

  markDown(base: string, error: unknown): void {
    if (isDeadHostError(error)) this.deadUntil.set(base, Date.now() + this.cooldownMs);
  }
}
