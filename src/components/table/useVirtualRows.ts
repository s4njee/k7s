/**
 * Virtual row windowing hook and constants for the resource table (B21).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { rowWindow, type RowWindow } from "../../lib/virtual";

/**
 * Row height used by the windowing math (B21), and the single source of it: it's
 * applied to windowed rows inline, so the spacer arithmetic and the real layout
 * cannot disagree. The design's rows are 28px.
 */
export const ROW_HEIGHT = 28;

/** Rows kept beyond each edge of the viewport, so fast scrolling stays filled. */
export const OVERSCAN = 20;

/**
 * Row count above which the table windows its rendering.
 *
 * Below it, every row is rendered exactly as before — which is what keeps the
 * table pixel-identical at ordinary cluster sizes (freya's largest kind is 71
 * rows).
 */
export const VIRTUAL_THRESHOLD = 200;

/** The sticky header's height, so a row isn't scrolled to sit behind it. */
export function headerHeight(scrollEl: HTMLElement): number {
  return scrollEl.querySelector("thead")?.getBoundingClientRect().height ?? 0;
}

/**
 * Width for a column in the windowed path, keyed by header name (B21).
 */
export function columnWidth(header: string): string {
  switch (header) {
    case "NAME":
    case "MESSAGE":
    case "REASON":
      return "22%";
    case "OBJECT":
    case "HOSTS":
    case "IMAGE":
      return "16%";
    case "NAMESPACE":
    case "PORTS":
    case "CLUSTER-IP":
    case "SCHEDULE":
      return "12%";
    case "AGE":
    case "READY":
    case "COUNT":
    case "TYPE":
    case "STATUS":
    case "RESTARTS":
    case "CPU":
    case "MEM":
      return "8%";
    default:
      return "10%";
  }
}

/**
 * Track scroll position and viewport height, and derive the row window from them.
 * Returns `virtual: false` for lists short enough to render whole.
 */
export function useVirtualRows(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  total: number,
): { virtual: boolean; window: RowWindow } {
  const virtual = total > VIRTUAL_THRESHOLD;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // A ref, so the scroll handler doesn't have to be re-attached when it flips.
  const virtualRef = useRef(virtual);
  virtualRef.current = virtual;

  // Seed from the DOM whenever windowing engages.
  useEffect(() => {
    const el = scrollRef.current;
    if (virtual && el) setScrollTop(el.scrollTop);
  }, [virtual, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      if (virtualRef.current) setScrollTop((prev) => (prev === el.scrollTop ? prev : el.scrollTop));
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => {
      setViewportH((prev) => (prev === el.clientHeight ? prev : el.clientHeight));
    });
    ro.observe(el);
    setViewportH((prev) => (prev === el.clientHeight ? prev : el.clientHeight));

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scrollRef]);

  // Key the memo on the *row* the scroll position lands on, not the raw pixel
  // value: a 1px scroll jitter within a row must not re-render the whole table
  // with a fresh window object (B78).
  const scrollRow = Math.floor(scrollTop / ROW_HEIGHT);
  const window = useMemo(
    () =>
      virtual
        ? rowWindow(total, scrollRow * ROW_HEIGHT, viewportH, ROW_HEIGHT, OVERSCAN)
        : { start: 0, end: total, padTop: 0, padBottom: 0 },
    [virtual, total, scrollRow, viewportH],
  );

  return { virtual, window };
}
