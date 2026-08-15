/**
 * Saved views (B60): a named table preset — kind, namespace, filter expression,
 * sort column/direction, and optional Problems scope — saved from the toolbar and
 * loaded from the toolbar or ⌘K. Carries the v5 spec forward, cid-keyed: views are
 * stored per cluster context (cid === context) and persisted with the rest of the
 * prefs, exactly like bookmarks.
 *
 * A view's sort is stored as the column *name*, not an index: indices shift when
 * the all-clusters problems scope prepends CLUSTER (and B87 will make columns
 * user-configurable), a name resolves cleanly at apply time.
 */

// SavedView lives in providers/types.ts (beside Bookmark) so Prefs can reference
// it without a cycle; this module re-exports it for the UI's convenience.
export type { SavedView } from "../providers/types";
import type { SavedView } from "../providers/types";

/** A deterministic slug for a view name ("CrashLoopBackOff pods" → "crashloopbackoff-pods"). */
export function viewId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a saved sort column name to the index the table expects, against the
 * RENDERED columns (the kind's base columns through B87's column config — which
 * already pins CLUSTER for the all-clusters problems scope). Null when the name
 * isn't present.
 */
export function viewSortIndex(view: SavedView, renderedColumns: string[]): number | null {
  if (!view.sortColName) return null;
  const idx = renderedColumns.findIndex((c) => c.toLowerCase() === view.sortColName!.toLowerCase());
  return idx === -1 ? null : idx;
}

/** Built-in views (v7): plain filter expressions, so they work on any cluster. */
export const BUILTIN_VIEWS: SavedView[] = [
  {
    id: "builtin-unhealthy-pods",
    name: "Unhealthy pods",
    builtin: true,
    kind: "pods",
    namespace: "all",
    filter: "status=CrashLoopBackOff|Error|Failed|Evicted|OOMKilled",
    sortColName: null,
    sortDir: "asc",
  },
  {
    id: "builtin-warnings",
    name: "Warnings",
    builtin: true,
    kind: "events",
    namespace: "all",
    filter: "type=Warning",
    sortColName: null,
    sortDir: "asc",
  },
  {
    id: "builtin-pending",
    name: "Pending workloads",
    builtin: true,
    kind: "pods",
    namespace: "all",
    filter: "status=Pending|ContainerCreating",
    sortColName: null,
    sortDir: "asc",
  },
  {
    id: "builtin-failures",
    name: "Recent failures",
    builtin: true,
    kind: "problems",
    namespace: "all",
    filter: "severity=error",
    sortColName: null,
    sortDir: "asc",
    problemsScope: "active",
  },
];
