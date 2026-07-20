/**
 * Column sorting for the resource table (B5).
 *
 * A column's cells are all the same shape, so we detect the sort mode once from a
 * sample cell and compare accordingly. Most columns need no data-side support:
 *   - explicit `cell.sort` number  → CPU/MEM (unit-ambiguous), set by the overlay/mock
 *   - `format === "age"`           → real age cells (ISO timestamp) → sort by epoch
 *   - "38%"                        → percent
 *   - "1/2"                        → ready-style fraction
 *   - "4d2h" / "3m12s" / "42s"     → duration (mock ages, job durations)
 *   - "14"                         → integer
 *   - anything else                → case-insensitive text
 * Missing values ("—" / empty) always sort last, regardless of direction.
 */

import type { Cell, Row } from "../providers/types";

export type SortDir = "asc" | "desc";

type Mode = "sort" | "age" | "percent" | "fraction" | "duration" | "int" | "text";

/** A cell value that carries no data (renders as an em dash or is blank). */
function isEmpty(text: string): boolean {
  return text === "" || text === "—";
}

/** Pick the comparison mode from the first non-empty cell in the column. */
function detectMode(cells: (Cell | undefined)[]): Mode {
  const sample = cells.find((c) => c && !isEmpty(c.text));
  if (!sample) return "text";
  if (sample.sort !== undefined) return "sort";
  if (sample.format === "age") return "age";
  if (/^\d+%$/.test(sample.text)) return "percent";
  if (/^\d+\/\d+$/.test(sample.text)) return "fraction";
  if (/^\d+[dhms]/.test(sample.text)) return "duration";
  if (/^-?\d+$/.test(sample.text)) return "int";
  return "text";
}

/** Sum a k8s-style duration ("4d2h", "3m12s", "42s") to seconds. */
function durationSeconds(text: string): number {
  const mult: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  let secs = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)([dhms])/g)) {
    secs += parseInt(n, 10) * mult[unit];
  }
  return secs;
}

/** Extract the comparable key for a cell in the given mode; null = missing/last. */
function sortKey(cell: Cell | undefined, mode: Mode, now: number): number | string | null {
  if (!cell || isEmpty(cell.text)) return null;
  const t = cell.text;
  switch (mode) {
    case "sort":
      return cell.sort ?? null;
    case "age": {
      // Real age cells hold an ISO timestamp; sort by age (now - creation).
      const ms = Date.parse(t);
      return Number.isNaN(ms) ? durationSeconds(t) : (now - ms) / 1000;
    }
    case "percent":
      return parseFloat(t);
    case "fraction": {
      const [a, b] = t.split("/").map(Number);
      return b ? a / b : 0;
    }
    case "duration":
      return durationSeconds(t);
    case "int":
      return parseInt(t, 10);
    default:
      return t.toLowerCase();
  }
}

/**
 * Return a new array of rows sorted by column `col`. Rows without a value for the
 * column sink to the bottom in both directions.
 */
export function sortRows(rows: Row[], col: number, dir: SortDir, now: number): Row[] {
  const mode = detectMode(rows.map((r) => r.cells[col]));
  const sign = dir === "asc" ? 1 : -1;

  const keyed = rows.map((r) => ({ r, k: sortKey(r.cells[col], mode, now) }));
  keyed.sort((a, b) => {
    if (a.k === null && b.k === null) return 0;
    if (a.k === null) return 1; // missing → last
    if (b.k === null) return -1;
    if (typeof a.k === "number" && typeof b.k === "number") return (a.k - b.k) * sign;
    return String(a.k).localeCompare(String(b.k)) * sign;
  });
  return keyed.map((x) => x.r);
}
