/**
 * Tests for the table windowing math (B21). These stand in for the thing that's
 * hard to assert automatically — that a 5k-row table scrolls smoothly — by
 * pinning the arithmetic that decides what's in the DOM at all.
 */

import { describe, expect, it } from "vitest";
import { rowWindow, scrollToShow } from "./virtual";

const ROW = 28;
const OVERSCAN = 20;
// A 700px viewport shows 25 rows of 28px.
const VIEW = 700;

describe("rowWindow", () => {
  it("renders from the top with no leading spacer", () => {
    const w = rowWindow(5000, 0, VIEW, ROW, OVERSCAN);
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
    // 25 visible + 20 overscan + 1 partial row.
    expect(w.end).toBe(46);
    expect(w.padBottom).toBe((5000 - 46) * ROW);
  });

  it("keeps a constant total height while scrolling, so the scrollbar is stable", () => {
    const full = 5000 * ROW;
    for (const scrollTop of [0, 1000, 50_000, 139_000]) {
      const w = rowWindow(5000, scrollTop, VIEW, ROW, OVERSCAN);
      const rendered = (w.end - w.start) * ROW;
      expect(w.padTop + rendered + w.padBottom).toBe(full);
    }
  });

  it("windows around the scroll position with overscan on both sides", () => {
    // Scrolled to row 100 exactly.
    const w = rowWindow(5000, 100 * ROW, VIEW, ROW, OVERSCAN);
    expect(w.start).toBe(80); // 100 - overscan
    expect(w.end).toBe(146); // 100 + 25 visible + 20 overscan + 1
    expect(w.padTop).toBe(80 * ROW);
  });

  it("clamps at the end of the list", () => {
    const w = rowWindow(5000, 5000 * ROW, VIEW, ROW, OVERSCAN);
    expect(w.end).toBe(5000);
    expect(w.padBottom).toBe(0);
  });

  it("renders every row when the list is shorter than the viewport", () => {
    const w = rowWindow(10, 0, VIEW, ROW, OVERSCAN);
    expect(w.start).toBe(0);
    expect(w.end).toBe(10);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe(0);
  });

  it("renders nothing for an empty list", () => {
    expect(rowWindow(0, 0, VIEW, ROW, OVERSCAN)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
    });
  });

  it("survives an unmeasured viewport instead of dividing by zero", () => {
    const w = rowWindow(5000, 0, 0, ROW, OVERSCAN);
    expect(w.start).toBe(0);
    expect(w.end).toBe(21); // overscan only
    expect(Number.isFinite(w.padBottom)).toBe(true);
  });
});

describe("scrollToShow", () => {
  const HEADER = 30;

  it("leaves an already-visible row alone", () => {
    // Row 10 sits at 280–308, inside the 30–700 usable window.
    expect(scrollToShow(10, 0, VIEW, ROW, HEADER)).toBeNull();
  });

  it("scrolls up to a row above the viewport, clearing the sticky header", () => {
    // Row 5 (140–168) while scrolled to 1000.
    const to = scrollToShow(5, 1000, VIEW, ROW, HEADER);
    expect(to).toBe(5 * ROW - HEADER);
  });

  it("counts a row hidden behind the sticky header as not visible", () => {
    // Row 36 starts at 1008; scrolled to 1000 the header covers up to 1030.
    const to = scrollToShow(36, 1000, VIEW, ROW, HEADER);
    expect(to).toBe(36 * ROW - HEADER);
  });

  it("scrolls down just far enough to reveal a row below the viewport", () => {
    // Row 30 ends at 868; the viewport bottom is 700.
    const to = scrollToShow(30, 0, VIEW, ROW, HEADER);
    expect(to).toBe(31 * ROW - VIEW);
  });

  it("never scrolls above the top of the list", () => {
    expect(scrollToShow(0, 500, VIEW, ROW, HEADER)).toBe(0);
  });

  it("ignores a cleared highlight", () => {
    expect(scrollToShow(-1, 0, VIEW, ROW, HEADER)).toBeNull();
  });
});
