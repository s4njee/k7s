import { describe, expect, it } from "vitest";
import { diffLines, hasChanges, hunks, diffStat } from "./diff";

/** Compact rendering, so expectations read like a diff. */
const render = (ls: { op: string; text: string }[]) =>
  ls.map((l) => `${l.op === "add" ? "+" : l.op === "del" ? "-" : " "}${l.text}`);

describe("diffLines", () => {
  it("reports no changes for identical text", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(hasChanges(d)).toBe(false);
    expect(d.every((l) => l.op === "same")).toBe(true);
  });

  it("shows a changed line as a delete followed by an add", () => {
    // The order matters for reading: -old above +new.
    expect(render(diffLines("a\nb\nc", "a\nB\nc"))).toEqual([" a", "-b", "+B", " c"]);
  });

  it("handles a pure insertion", () => {
    expect(render(diffLines("a\nc", "a\nb\nc"))).toEqual([" a", "+b", " c"]);
  });

  it("handles a pure deletion", () => {
    expect(render(diffLines("a\nb\nc", "a\nc"))).toEqual([" a", "-b", " c"]);
  });

  it("carries line numbers for each side", () => {
    const d = diffLines("a\nb", "a\nB");
    const del = d.find((l) => l.op === "del")!;
    const add = d.find((l) => l.op === "add")!;
    expect(del.before).toBe(2);
    expect(del.after).toBeUndefined();
    expect(add.after).toBe(2);
    expect(add.before).toBeUndefined();
  });

  // YAML repeats similar keys; a greedy scan resynchronises on the wrong one and
  // reports a much larger diff than actually happened.
  it("finds a minimal diff through repeated similar lines", () => {
    const before = ["spec:", "  a: 1", "  b: 2", "  c: 3"].join("\n");
    const after = ["spec:", "  a: 1", "  b: 99", "  c: 3"].join("\n");
    const d = diffLines(before, after);
    expect(diffStat(d)).toEqual({ added: 1, removed: 1 });
  });

  it("diffs against empty text as all additions", () => {
    expect(diffStat(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 1 });
  });
});

describe("hunks", () => {
  const doc = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

  it("returns nothing when there are no changes — the caller says 'no changes'", () => {
    expect(hunks(diffLines(doc(50), doc(50)))).toEqual([]);
  });

  // The point of hunking: one change in a long manifest is one small hunk, not
  // the whole file.
  it("keeps only the changed region plus context", () => {
    const before = doc(50);
    const after = before.replace("line25", "line25-CHANGED");
    const hs = hunks(diffLines(before, after), 3);
    expect(hs.length).toBe(1);
    // 3 context + del + add + 3 context
    expect(hs[0].length).toBe(8);
    expect(hs[0][0].text).toBe("line22");
    expect(hs[0][hs[0].length - 1].text).toBe("line28");
  });

  it("splits distant changes into separate hunks", () => {
    const before = doc(50);
    const after = before.replace("line5", "line5-X").replace("line40", "line40-X");
    expect(hunks(diffLines(before, after), 3).length).toBe(2);
  });

  it("merges changes close enough that their context overlaps", () => {
    const before = doc(50);
    const after = before.replace("line20", "line20-X").replace("line22", "line22-X");
    const hs = hunks(diffLines(before, after), 3);
    expect(hs.length).toBe(1);
  });

  it("clamps context at the start and end of the document", () => {
    const before = doc(4);
    const after = before.replace("line1", "line1-X");
    const hs = hunks(diffLines(before, after), 3);
    // No crash and no phantom lines before the first.
    expect(hs[0][0].text).toBe("line1");
  });
});

describe("diffStat", () => {
  it("counts additions and removals", () => {
    const d = diffLines("a\nb\nc", "a\nX\nY\nc");
    expect(diffStat(d)).toEqual({ added: 2, removed: 1 });
  });
});
