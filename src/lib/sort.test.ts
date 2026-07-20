/**
 * Tests for the table sort comparator. Rows are minimal — only the column under
 * test needs realistic cells.
 */

import { describe, it, expect } from "vitest";
import { sortRows } from "./sort";
import type { Cell, Row } from "../providers/types";

const NOW = Date.parse("2026-07-15T12:00:00Z");

/** Build a row whose single cell (col 0) is `cell`, tagged with `name` as uid. */
function row(name: string, cell: Cell): Row {
  return { uid: name, name, cells: [cell] };
}
const names = (rows: Row[]) => rows.map((r) => r.name);

describe("sortRows", () => {
  it("sorts RESTARTS numerically, not lexically (14 > 2)", () => {
    const rows = [
      row("a", { text: "2", tone: "secondary" }),
      row("b", { text: "14", tone: "err" }),
      row("c", { text: "0", tone: "secondary" }),
    ];
    expect(names(sortRows(rows, 0, "desc", NOW))).toEqual(["b", "a", "c"]);
  });

  it("sorts AGE by real duration, not string (2h14m < 4d2h < 31d)", () => {
    const rows = [
      row("old", { text: "31d", tone: "muted" }),
      row("young", { text: "2h14m", tone: "muted" }),
      row("mid", { text: "4d2h", tone: "muted" }),
    ];
    // Ascending by age → youngest first.
    expect(names(sortRows(rows, 0, "asc", NOW))).toEqual(["young", "mid", "old"]);
  });

  it("sorts CPU/MEM by numeric sort key with missing last", () => {
    const rows = [
      row("big", { text: "3.2Gi", tone: "secondary", sort: 3.2 * 1024 ** 3 }),
      row("small", { text: "486Mi", tone: "secondary", sort: 486 * 1024 ** 2 }),
      row("none", { text: "—", tone: "secondary" }),
    ];
    // Descending → big, small, then missing (always last).
    expect(names(sortRows(rows, 0, "desc", NOW))).toEqual(["big", "small", "none"]);
    // Ascending → small, big, missing still last.
    expect(names(sortRows(rows, 0, "asc", NOW))).toEqual(["small", "big", "none"]);
  });

  it("sorts READY by fraction (0/3 < 1/2 < 3/3)", () => {
    const rows = [
      row("full", { text: "3/3", tone: "secondary" }),
      row("none", { text: "0/3", tone: "warn" }),
      row("half", { text: "1/2", tone: "warn" }),
    ];
    expect(names(sortRows(rows, 0, "asc", NOW))).toEqual(["none", "half", "full"]);
  });

  it("sorts percent columns numerically (8% < 38%)", () => {
    const rows = [
      row("hi", { text: "38%", tone: "secondary" }),
      row("lo", { text: "8%", tone: "secondary" }),
    ];
    expect(names(sortRows(rows, 0, "asc", NOW))).toEqual(["lo", "hi"]);
  });

  it("sorts plain text case-insensitively", () => {
    const rows = [
      row("z", { text: "Zebra", tone: "primary" }),
      row("a", { text: "apple", tone: "primary" }),
    ];
    expect(names(sortRows(rows, 0, "asc", NOW))).toEqual(["a", "z"]);
  });
});
