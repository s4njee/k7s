/**
 * Column configuration (B87): per-{cid, kind} visibility, order, widths, and
 * local custom columns (label / annotation / restricted JSONPath). The table
 * renders through a descriptor (`ColumnRef[]`) that maps each rendered position
 * to a base cell index — or a custom column — so hiding/reordering never mutates
 * the base `row.cells` (overlayMetrics, sortRows, and the filter all index the
 * base array).
 *
 * CLUSTER (the all-clusters problems scope's leading cell) is a scope-dependent
 * pseudo-column: it's pinned first and never configurable; the config keys the
 * five base problems columns.
 */

// The model types live in providers/types.ts (beside Bookmark/SavedView, which
// they persist with, and where Prefs can reference them without a cycle); this
// module re-exports them and adds the pure helpers.
export type { ColumnPrefs, ColumnRef, CustomColumn } from "../providers/types";
import type { Cell, ColumnPrefs, ColumnRef, CustomColumn, Row } from "../providers/types";
import { jsonpathCell } from "./jsonpath";

export const EMPTY_COLUMN_PREFS: ColumnPrefs = { hidden: [], order: null, widths: {}, custom: [] };

/** The stable id for a custom column (type + key/path). */
export function customColumnId(c: CustomColumn): string {
  return c.type === "jsonpath" ? `jsonpath:${c.path}` : `${c.type}:${c.key}`;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * The rendered column descriptor for a kind, given its full base column list
 * (which already includes CLUSTER first for the all-clusters problems scope) and
 * the saved config. CLUSTER stays pinned at index 0; the config applies to the
 * rest (hidden/order, then custom columns appended). Base names that no longer
 * exist (CRD printer columns change between connects) are dropped.
 */
export function resolveColumns(baseColumns: string[], prefs?: ColumnPrefs): ColumnRef[] {
  const p = prefs ?? EMPTY_COLUMN_PREFS;
  const cluster = baseColumns[0] === "CLUSTER";
  const rest = cluster ? baseColumns.slice(1) : baseColumns;
  const hidden = new Set(p.hidden.map(lower));

  const refs: ColumnRef[] = [];
  if (cluster) refs.push({ name: "CLUSTER", baseIndex: 0 });

  const used = new Set<string>();
  const push = (name: string, baseIndex: number) => {
    used.add(lower(name));
    refs.push({ name, baseIndex });
  };

  // The configured order, restricted to names that still exist, then the rest of
  // the base columns in their natural order (so a partial order still shows all).
  const ordered = p.order
    ? p.order.filter((n) => rest.some((c) => lower(c) === lower(n)))
    : rest;
  for (const name of ordered) {
    const idx = rest.findIndex((c) => lower(c) === lower(name));
    if (idx === -1 || hidden.has(lower(name))) continue;
    push(rest[idx], cluster ? idx + 1 : idx);
  }
  for (const name of rest) {
    if (used.has(lower(name)) || hidden.has(lower(name))) continue;
    push(name, cluster ? rest.indexOf(name) + 1 : rest.indexOf(name));
  }

  for (const c of p.custom) refs.push({ name: c.name, baseIndex: null, custom: c });
  return refs;
}

/** The object a JSONPath custom column evaluates against — the row's structured
 *  fields (annotations are the raw keys, so dotted keys stay addressable here). */
function rowObject(row: Row): Record<string, unknown> {
  return {
    labels: row.labels,
    annotations: row.annotations,
    name: row.name,
    namespace: row.namespace,
  };
}

/** Evaluate a custom column for a row; a missing value renders as "—". Numeric
 *  label/annotation values carry a `sort` key so the column can be sorted. */
export function customCell(row: Row, col: CustomColumn): Cell {
  const missing: Cell = { text: "—", tone: "secondary" };
  let value: string | undefined;
  switch (col.type) {
    case "label":
      value = row.labels?.[col.key];
      break;
    case "annotation":
      value = row.annotations?.[col.key];
      break;
    case "jsonpath": {
      const cell = jsonpathCell(col.path, rowObject(row));
      return cell.text === "—" ? missing : cell;
    }
  }
  if (value == null || value === "") return missing;
  const n = Number(value);
  return Number.isFinite(n) && value.trim() !== ""
    ? { text: value, tone: "secondary", sort: n }
    : { text: value, tone: "secondary" };
}

/** A row plus its RENDERED cells (B87): the configured subset/order + custom
 *  columns. Built after filter/overlay and sorted by the rendered index — the
 *  base `row.cells` is never mutated (overlayMetrics/sortRows index it). */
export type DisplayRow = { row: Row; cells: Cell[] };

/** The rendered cells for one row: base cells (subset + order) then custom cells. */
export function renderedCells(row: Row, refs: ColumnRef[]): Cell[] {
  return refs.map((ref) =>
    ref.custom ? customCell(row, ref.custom) : (row.cells[ref.baseIndex as number] ?? { text: "—", tone: "secondary" as const }),
  );
}

// ---- pure config transforms (the store stores the result; these stay testable) ----

export function toggleColumnPrefs(p: ColumnPrefs, name: string): ColumnPrefs {
  const hidden = p.hidden.includes(name)
    ? p.hidden.filter((n) => n !== name)
    : [...p.hidden, name];
  return { ...p, hidden };
}

/** Move a base column one position within the configured order (no-op at the ends). */
export function moveColumnPrefs(p: ColumnPrefs, name: string, dir: -1 | 1): ColumnPrefs {
  const order = p.order ?? [];
  const idx = order.findIndex((n) => n === name);
  if (idx === -1) {
    // Not yet in the order: build it from the default by inserting beside the
    // neighbours the config already names.
    const insert = dir === 1 ? order.length : 0;
    const next = order.slice();
    next.splice(insert, 0, name);
    return { ...p, order: next };
  }
  const target = idx + dir;
  if (target < 0 || target >= order.length) return p;
  const next = order.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  return { ...p, order: next };
}

export function withColumnWidth(p: ColumnPrefs, name: string, width: number): ColumnPrefs {
  return { ...p, widths: { ...p.widths, [name]: Math.max(5, Math.min(90, width)) } };
}

export function addCustomColumnPrefs(p: ColumnPrefs, c: CustomColumn): ColumnPrefs {
  if (p.custom.some((x) => x.id === c.id)) return p;
  return { ...p, custom: [...p.custom, c] };
}

export function removeCustomColumnPrefs(p: ColumnPrefs, id: string): ColumnPrefs {
  return { ...p, custom: p.custom.filter((c) => c.id !== id) };
}

export function moveCustomColumnPrefs(p: ColumnPrefs, id: string, dir: -1 | 1): ColumnPrefs {
  const idx = p.custom.findIndex((c) => c.id === id);
  if (idx === -1) return p;
  const target = idx + dir;
  if (target < 0 || target >= p.custom.length) return p;
  const next = p.custom.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  return { ...p, custom: next };
}

/** Move a base column from one position to another in the display order (drag
 *  reorder). When no custom order exists yet, the kind's full column list is the
 *  order to move within. */
export function reorderColumnPrefs(
  p: ColumnPrefs,
  baseColumns: string[],
  from: string,
  to: string,
): ColumnPrefs {
  const order = p.order ?? baseColumns.slice();
  const fromIdx = order.findIndex((n) => n === from);
  const toIdx = order.findIndex((n) => n === to);
  if (fromIdx === -1 || toIdx === -1) return p;
  const next = order.slice();
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, from);
  return { ...p, order: next };
}
