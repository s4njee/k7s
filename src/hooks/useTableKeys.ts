/**
 * Keyboard navigation for the resource table (B10). Returns the index of the
 * currently highlighted row (or -1). Bindings (ignored while typing):
 *   j / ↓   move highlight down        k / ↑   move highlight up
 *   Enter   open the highlighted row   G       jump to last
 *   gg      jump to first              /       focus the filter field
 *
 * Refs keep the single document listener stable across renders; `resetKey` (the
 * nav kind) clears the highlight when the row set is wholly replaced.
 */

import { useEffect, useRef, useState } from "react";
import { isTypingTarget } from "../lib/dom";
import type { Row } from "../providers/types";

export function useTableKeys(
  rows: Row[],
  onEnter: (row: Row) => void,
  focusFilter: () => void,
  resetKey: string,
): number {
  const [highlight, setHighlightState] = useState(-1);

  // Refs so the keydown listener (attached once) always sees current values.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const hlRef = useRef(-1);
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;
  const focusRef = useRef(focusFilter);
  focusRef.current = focusFilter;
  const lastG = useRef(0);

  const setHighlight = (v: number) => {
    hlRef.current = v;
    setHighlightState(v);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(document.activeElement)) return;
      const n = rowsRef.current.length;
      const h = hlRef.current;
      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          if (n) setHighlight(Math.min(n - 1, h + 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          if (n) setHighlight(Math.max(0, (h < 0 ? 0 : h) - 1));
          break;
        case "Enter":
          if (h >= 0 && h < n) onEnterRef.current(rowsRef.current[h]);
          break;
        case "G":
          if (n) setHighlight(n - 1);
          break;
        case "g": {
          // Double-press within 400ms jumps to the top.
          const now = Date.now();
          if (now - lastG.current < 400 && n) setHighlight(0);
          lastG.current = now;
          break;
        }
        case "/":
          e.preventDefault();
          focusRef.current();
          break;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Clear the highlight when the kind changes (rows are a different set).
  useEffect(() => {
    setHighlight(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Keep the highlight in range as rows shrink (filter/live updates).
  useEffect(() => {
    if (hlRef.current >= rows.length) setHighlight(rows.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  return highlight;
}
