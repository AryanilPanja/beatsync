export interface LrcLine {
  /** Timestamp in seconds */
  time: number;
  text: string;
}

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (some files use ":" before the fraction)
const LEADING_TIMESTAMP = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

const toSeconds = (match: RegExpExecArray) => {
  const fraction = match[3] ? parseInt(match[3], 10) / 10 ** match[3].length : 0;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10) + fraction;
};

/**
 * Parse an LRC file string into an array of timestamped lines, sorted by time.
 * - Lines with several timestamps ("[00:12.00][01:30.00]chorus") yield one entry per timestamp.
 * - Metadata tags ([ar:], [ti:], ...) are ignored; [offset:±ms] shifts every line (positive = earlier).
 * - Blank lines are dropped unless `keepEmpty` is set (useful to show instrumental gaps).
 */
export function parseLrc(raw: string, options: { keepEmpty?: boolean } = {}): LrcLine[] {
  const lines: LrcLine[] = [];
  let offsetSeconds = 0;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();

    const offsetMatch = OFFSET_TAG.exec(line);
    if (offsetMatch) {
      offsetSeconds = parseInt(offsetMatch[1], 10) / 1000;
      continue;
    }

    const times: number[] = [];
    let rest = line;
    let match: RegExpExecArray | null;
    while ((match = LEADING_TIMESTAMP.exec(rest))) {
      times.push(toSeconds(match));
      rest = rest.slice(match[0].length);
    }
    if (times.length === 0) continue;

    const text = rest.trim().replaceAll("\\n", "\n");
    if (!text && !options.keepEmpty) continue;

    for (const time of times) lines.push({ time, text });
  }

  return lines
    .map((line) => ({ ...line, time: Math.max(0, line.time - offsetSeconds) }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Find the index of the current lyric line for a given playback time.
 * Returns -1 if playback hasn't reached the first line yet.
 */
export function getCurrentLineIndex(data: { lines: LrcLine[]; timeSeconds: number }): number {
  const { lines, timeSeconds } = data;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= timeSeconds) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
}
