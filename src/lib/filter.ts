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
 * Test a row against a parsed filter. Label selectors must all match the pod's
 * labels (a non-pod row has none, so any selector rejects it); the text term is
 * a name substring, except for Events whose name is an opaque id — there it
 * matches across the visible cells, as the pre-B33 filter did.
 */
export function matchesFilter(row: Row, f: ParsedFilter, nav: KindId): boolean {
  if (f.labels.length) {
    const labels = row.labels;
    if (!labels) return false;
    for (const [k, v] of f.labels) {
      if (labels[k] !== v) return false;
    }
  }
  if (f.text === "") return true;
  return nav === "events"
    ? row.cells.some((c) => c.text.toLowerCase().includes(f.text))
    : row.name.toLowerCase().includes(f.text);
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
