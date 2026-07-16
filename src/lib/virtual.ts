/**
 * Windowing math for the resource table (B21).
 *
 * Pure functions, kept out of the component so the arithmetic that decides which
 * rows exist in the DOM is directly testable — an off-by-one here shows up as
 * rows visibly misaligned from the scrollbar, which is miserable to debug by eye.
 *
 * All of this assumes a fixed row height. That's why virtualized rows get an
 * explicit height in CSS rather than sizing to their content (see
 * ResourceTable.module.css `.rowFixed`): the padding spacers are computed from
 * `rowH`, so if a real row were even a pixel taller the window would drift out of
 * step with the scroll position.
 */

/** The rendered slice of a row list, plus the spacer heights around it. */
export interface RowWindow {
  /** First row index to render (inclusive). */
  start: number;
  /** Last row index to render (exclusive). */
  end: number;
  /** Height of the spacer standing in for rows before `start`. */
  padTop: number;
  /** Height of the spacer standing in for rows after `end`. */
  padBottom: number;
}

/**
 * Which rows to render for a given scroll position.
 *
 * `overscan` rows are kept beyond each edge so a fast scroll doesn't expose blank
 * space before React re-renders.
 */
export function rowWindow(
  total: number,
  scrollTop: number,
  viewportH: number,
  rowH: number,
  overscan: number,
): RowWindow {
  // Degenerate viewport (not yet measured, or a zero-height panel): render nothing
  // rather than dividing the list by zero.
  if (total <= 0 || rowH <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }

  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const visibleCount = Math.ceil(Math.max(0, viewportH) / rowH);

  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visibleCount + overscan + 1);

  return {
    start,
    end,
    padTop: start * rowH,
    padBottom: Math.max(0, (total - end) * rowH),
  };
}

/**
 * The scroll position needed to bring row `index` into view, or null if it's
 * already fully visible (so callers don't fight the user's own scrolling).
 *
 * `headerH` is the sticky header's height: it overlays the top of the scroll
 * area, so a row scrolled flush to the top would sit behind it.
 */
export function scrollToShow(
  index: number,
  scrollTop: number,
  viewportH: number,
  rowH: number,
  headerH: number,
): number | null {
  if (index < 0 || rowH <= 0) return null;

  const rowTop = index * rowH;
  const rowBottom = rowTop + rowH;
  // The usable window starts below the sticky header.
  const viewTop = scrollTop + headerH;
  const viewBottom = scrollTop + viewportH;

  if (rowTop < viewTop) return Math.max(0, rowTop - headerH);
  if (rowBottom > viewBottom) return rowBottom - viewportH;
  return null; // already visible
}
