// LRC files from LRCLIB and elsewhere vary in timestamp precision and features. A parse
// miss silently drops or mistimes lines, so lyrics drift from the music on every device.

import { describe, expect, it } from "bun:test";
import { parseLrc } from "@/lib/lrc";

describe("parseLrc", () => {
  it("accepts 2- and 3-digit fractions and timestamps without a fraction", () => {
    const lines = parseLrc("[00:01.50] two\n[00:02.250] three\n[00:03] none");
    expect(lines.map((l) => l.time)).toEqual([1.5, 2.25, 3]);
  });

  it("expands lines with several timestamps into one entry per timestamp, in time order", () => {
    const lines = parseLrc("[00:30.00][00:10.00]chorus\n[00:20.00]verse");
    expect(lines).toEqual([
      { time: 10, text: "chorus" },
      { time: 20, text: "verse" },
      { time: 30, text: "chorus" },
    ]);
  });

  it("ignores metadata tags and applies [offset:] (positive shows lyrics earlier)", () => {
    const lines = parseLrc("[ar:Queen]\n[ti:Bohemian Rhapsody]\n[offset:+500]\n[00:10.00]line");
    expect(lines).toEqual([{ time: 9.5, text: "line" }]);
  });

  it("keeps blank lines only when asked, so instrumental gaps can be shown", () => {
    const raw = "[00:01.00]sing\n[00:05.00]\n[00:09.00]again";
    expect(parseLrc(raw).map((l) => l.text)).toEqual(["sing", "again"]);
    expect(parseLrc(raw, { keepEmpty: true }).map((l) => l.text)).toEqual(["sing", "", "again"]);
  });
});
