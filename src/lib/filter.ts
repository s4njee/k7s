/**
 * Table-filter parsing and matching (B33).
 *
 * The filter box accepts two kinds of term, freely mixed:
 *   - a **name substring** — any bare word, matched case-insensitively against
 *     the row's name (or, for the opaque-named Events feed, across its cells);
 *   - a **label selector** — a `key=value` term, matched against a pod's labels.
 *     Multiple selectors AND together, separated by whitespace *or* commas, so a
 *     workload's `matchLabels` pastes in verbatim as `app=wiki,tier=web`.
 *
 * This exists so "view pods" on a workload can drop that workload's selector
 * straight into the filter (B33's workload→pods jump). Only pods carry labels on
 * their row, so a `key=value` term against any other kind matches nothing — which
 * is the correct selector semantics, not a bug.
 *
 * With no `key=value` term the behaviour is exactly the pre-B33 substring filter,
 * so existing muscle memory is untouched.
 */

import type { KindId, Row } from "../providers/types";

/** A filter split into its label selectors and its free-text remainder. */
export interface ParsedFilter {
  /** Name/cell substring (the non-selector words, space-joined, lowercased). */
  text: string;
  /** `key=value` selectors, ANDed together. */
  labels: [string, string][];
}

/**
 * Split a raw filter string into label selectors and free text.
 *
 * Terms split on whitespace or commas; a term with an `=` (and a non-empty key
 * before it) is a selector, everything else is name text. A k8s name can't
 * contain `=` or a comma, so this never misreads a name as a selector.
 */
export function parseFilter(raw: string): ParsedFilter {
  const labels: [string, string][] = [];
  const words: string[] = [];
  for (const tok of raw.trim().split(/[\s,]+/)) {
    if (!tok) continue;
    const eq = tok.indexOf("=");
    if (eq > 0) labels.push([tok.slice(0, eq), tok.slice(eq + 1)]);
    else words.push(tok);
  }
  return { text: words.join(" ").toLowerCase(), labels };
}

/** True if the raw filter contains anything to match on. */
export function isEmptyFilter(f: ParsedFilter): boolean {
  return f.text === "" && f.labels.length === 0;
}

/**
 * Test a row against a parsed filter.
 *
 * A `key=value` term is a **column match** when the key names a column of the
 * kind (case-insensitive): the value must equal that cell's text (case-
 * insensitive, trimmed), and `|` splits the value into OR alternatives — so
 * `status=CrashLoopBackOff|Error|Failed` matches any of those statuses (B60,
 * saved-view built-ins). Any other `key=value` stays a **label selector**: it
 * must match the pod's labels exactly (a non-pod row has none, so it rejects),
 * which is the unchanged pre-B60 k8s-selector behaviour.
 *
 * The text term is a name substring, except for Events/Problems whose names are
 * opaque ids — there it matches across the visible cells, as always.
 */
export function matchesFilter(
  row: Row,
  f: ParsedFilter,
  nav: KindId,
  columns: string[] = [],
): boolean {
  for (const [k, v] of f.labels) {
    const colIdx = columnIndex(k, columns);
    if (colIdx !== -1) {
      if (!cellMatches(row.cells[colIdx]?.text, v)) return false;
    } else {
      const labels = row.labels;
      if (!labels || labels[k] !== v) return false;
    }
  }
  if (f.text === "") return true;
  // Events and Problems have no meaningful NAME to match on (an event's name is
  // an opaque id; a problem's name is the object, but its reason is where you'd
  // search), so the text matches across the visible cells for both.
  return nav === "events" || nav === "problems"
    ? row.cells.some((c) => c.text.toLowerCase().includes(f.text))
    : row.name.toLowerCase().includes(f.text);
}

/** Case-insensitive index of a column name in the kind's column list, else -1. */
function columnIndex(key: string, columns: string[]): number {
  const k = key.toLowerCase();
  return columns.findIndex((c) => c.toLowerCase() === k);
}

/** Exact (trimmed, case-insensitive) cell match; `|` is an OR of alternatives. */
function cellMatches(text: string | undefined, value: string): boolean {
  if (text == null) return false;
  const t = text.trim().toLowerCase();
  return value.split("|").some((alt) => alt.trim().toLowerCase() === t);
}

/**
 * Build a selector filter string from a workload's `matchLabels`, in the
 * canonical `k=v,k2=v2` form (sorted for stability) that {@link parseFilter}
 * reads back. Empty when there are no labels.
 */
export function selectorFilter(matchLabels: Record<string, string>): string {
  return Object.keys(matchLabels)
    .sort()
    .map((k) => `${k}=${matchLabels[k]}`)
    .join(",");
}
