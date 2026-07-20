/**
 * Multi-row selection (B39) — the pure part.
 *
 * Selection is a set of row **uids** plus an anchor, never indices or row
 * objects. Both alternatives are actively wrong here:
 *   - Row objects are replaced wholesale on every watch update (`setRows`), so
 *     identity comparison would drop the selection a second after you made it.
 *   - Indices shift under sorting, filtering, and the 30-second age re-render.
 *     A selection pinned to index 3 would silently come to mean a different pod.
 *
 * The ordered uid list is passed in rather than read from a store, because the
 * visible order is produced by ResourceTable's filter→overlay→sort pipeline and
 * only exists there. Keeping that a parameter is what makes range selection
 * testable without a DOM, a store, or a cluster.
 */

/** Which modifier the user held. Named rather than passed as a raw event so the
 *  caller does the platform mapping (⌘ on macOS, Ctrl elsewhere) exactly once. */
export interface ClickMods {
  /** Extend from the anchor to here. */
  range: boolean;
  /** Add/remove this one, leaving the rest alone. */
  toggle: boolean;
}

export interface SelectionState {
  /** Selected uids. Order is not meaningful; callers re-derive display order. */
  selected: string[];
  /** Where a range extends *from*. Null when there's nothing to extend from. */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null };

/**
 * Apply a click to the selection, following the convention every file manager
 * and editor uses — because this is muscle memory, not a place to be creative.
 *
 *   plain    → this row alone becomes the selection, and the anchor
 *   toggle   → flip this row; it becomes the anchor so a later range starts here
 *   range    → replace the selection with anchor..this inclusive; anchor unmoved,
 *              so repeated shift-clicks re-extend from the original point rather
 *              than ratcheting outward one row at a time
 *
 * A range click with no anchor (nothing selected yet) degrades to a plain click
 * rather than doing nothing, which is what people expect from a first shift-click.
 */
export function applyClick(
  state: SelectionState,
  orderedUids: string[],
  uid: string,
  mods: ClickMods,
): SelectionState {
  if (mods.range && state.anchor !== null) {
    const from = orderedUids.indexOf(state.anchor);
    const to = orderedUids.indexOf(uid);
    // The anchor can have been filtered or sorted out from under us; falling back
    // to a plain selection beats selecting a nonsense range.
    if (from === -1 || to === -1) return { selected: [uid], anchor: uid };
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return { selected: orderedUids.slice(lo, hi + 1), anchor: state.anchor };
  }

  if (mods.toggle) {
    const has = state.selected.includes(uid);
    const selected = has ? state.selected.filter((u) => u !== uid) : [...state.selected, uid];
    // Deselecting the last row leaves nothing to extend from.
    return { selected, anchor: selected.length === 0 ? null : uid };
  }

  return { selected: [uid], anchor: uid };
}

/**
 * What a right-click should select before the menu opens.
 *
 * Right-clicking *inside* an existing selection keeps it — that's how you act on
 * many rows at once, and stomping it would make bulk actions unreachable by
 * mouse. Right-clicking outside collapses to the clicked row, so the menu can
 * never act on rows you can't see you've selected.
 */
export function selectionForContextMenu(
  state: SelectionState,
  uid: string,
): SelectionState {
  if (state.selected.includes(uid)) return state;
  return { selected: [uid], anchor: uid };
}

/**
 * Drop uids that are no longer present.
 *
 * Filtering, sorting, and namespace changes can hide rows while the selection
 * still names them. Without pruning, "delete 3 selected" could act on a pod that
 * scrolled out of the filter ten minutes ago — the user would be confirming a
 * list they cannot see.
 */
export function pruneSelection(state: SelectionState, presentUids: string[]): SelectionState {
  const present = new Set(presentUids);
  const selected = state.selected.filter((u) => present.has(u));
  const anchor = state.anchor !== null && present.has(state.anchor) ? state.anchor : null;
  // Identity is preserved only when *nothing* changed. The anchor has to be part
  // of that test: it can vanish while every selected row is still present (it is
  // not required to be selected), and short-circuiting on the row count alone
  // would leave a stale anchor pointing at a filtered-away row.
  if (selected.length === state.selected.length && anchor === state.anchor) return state;
  return { selected, anchor };
}

/** Selected rows in display order, which is the order a confirmation must list. */
export function selectedInOrder<T extends { uid: string }>(
  state: SelectionState,
  ordered: T[],
): T[] {
  const sel = new Set(state.selected);
  return ordered.filter((r) => sel.has(r.uid));
}

/**
 * Is this a real multi-selection?
 *
 * One row is not "bulk": a single selected row behaves exactly like the detail
 * panel's target, and treating it as a bulk operation would give it a plural
 * confirmation dialog for no reason.
 */
export function isBulk(state: SelectionState): boolean {
  return state.selected.length > 1;
}
