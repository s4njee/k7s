import { describe, expect, it } from "vitest";
import {
  applyClick,
  EMPTY_SELECTION,
  isBulk,
  pruneSelection,
  selectedInOrder,
  selectionForContextMenu,
  type SelectionState,
} from "./selection";

const ORDER = ["a", "b", "c", "d", "e"];
const plain = { range: false, toggle: false };
const toggle = { range: false, toggle: true };
const range = { range: true, toggle: false };

const state = (selected: string[], anchor: string | null = null): SelectionState => ({
  selected,
  anchor,
});

describe("applyClick — plain", () => {
  it("replaces the selection and moves the anchor", () => {
    expect(applyClick(state(["a", "b"], "a"), ORDER, "d", plain)).toEqual({
      selected: ["d"],
      anchor: "d",
    });
  });
});

describe("applyClick — toggle", () => {
  it("adds a row without disturbing the rest", () => {
    expect(applyClick(state(["a"], "a"), ORDER, "c", toggle)).toEqual({
      selected: ["a", "c"],
      anchor: "c",
    });
  });

  it("removes an already-selected row", () => {
    expect(applyClick(state(["a", "c"], "c"), ORDER, "a", toggle).selected).toEqual(["c"]);
  });

  /** With nothing left, a later shift-click has no meaningful origin. */
  it("clears the anchor when the last row is deselected", () => {
    expect(applyClick(state(["a"], "a"), ORDER, "a", toggle)).toEqual({
      selected: [],
      anchor: null,
    });
  });
});

describe("applyClick — range", () => {
  it("selects the inclusive span from the anchor", () => {
    expect(applyClick(state(["b"], "b"), ORDER, "d", range).selected).toEqual(["b", "c", "d"]);
  });

  it("works backwards", () => {
    expect(applyClick(state(["d"], "d"), ORDER, "b", range).selected).toEqual(["b", "c", "d"]);
  });

  /**
   * The anchor must not move, or repeated shift-clicks would ratchet the range
   * outward one row at a time instead of re-extending from where you started.
   */
  it("leaves the anchor where it was, so the range can be re-extended", () => {
    const first = applyClick(state(["b"], "b"), ORDER, "e", range);
    expect(first.anchor).toBe("b");
    const narrowed = applyClick(first, ORDER, "c", range);
    expect(narrowed.selected).toEqual(["b", "c"]);
  });

  /** A first shift-click with nothing selected should still select something. */
  it("degrades to a plain click with no anchor", () => {
    expect(applyClick(EMPTY_SELECTION, ORDER, "c", range)).toEqual({
      selected: ["c"],
      anchor: "c",
    });
  });

  /**
   * Sorting or filtering can remove the anchor while it's still recorded.
   * Selecting a span between a row that no longer exists and one that does would
   * be arbitrary, so it collapses to the clicked row.
   */
  it("falls back to a plain click when the anchor has been filtered away", () => {
    expect(applyClick(state(["z"], "z"), ORDER, "c", range)).toEqual({
      selected: ["c"],
      anchor: "c",
    });
  });
});

describe("selectionForContextMenu", () => {
  /** Otherwise bulk actions would be unreachable: right-clicking to open the
   *  menu would destroy the very selection you meant to act on. */
  it("keeps the selection when right-clicking inside it", () => {
    const s = state(["a", "b"], "a");
    expect(selectionForContextMenu(s, "b")).toBe(s);
  });

  /** The menu must never act on rows the user can't see are selected. */
  it("collapses to the clicked row when right-clicking outside it", () => {
    expect(selectionForContextMenu(state(["a", "b"], "a"), "d")).toEqual({
      selected: ["d"],
      anchor: "d",
    });
  });
});

describe("pruneSelection", () => {
  it("drops uids that are no longer present", () => {
    expect(pruneSelection(state(["a", "z"], "a"), ORDER).selected).toEqual(["a"]);
  });

  it("clears an anchor that has gone", () => {
    expect(pruneSelection(state(["a"], "z"), ORDER).anchor).toBeNull();
  });

  /** Returning a fresh object every render would loop a React effect. */
  it("preserves identity when nothing changed", () => {
    const s = state(["a", "b"], "a");
    expect(pruneSelection(s, ORDER)).toBe(s);
  });
});

describe("selectedInOrder", () => {
  /** A confirmation lists rows in the order they appear on screen, not the
   *  order they happened to be clicked. */
  it("returns rows in display order, not click order", () => {
    const rows = ORDER.map((uid) => ({ uid }));
    expect(selectedInOrder(state(["d", "a"], "d"), rows).map((r) => r.uid)).toEqual(["a", "d"]);
  });
});

describe("isBulk", () => {
  it("treats a single row as not bulk", () => {
    expect(isBulk(state(["a"]))).toBe(false);
    expect(isBulk(state(["a", "b"]))).toBe(true);
    expect(isBulk(EMPTY_SELECTION)).toBe(false);
  });
});
