/**
 * useClickOutside — calls `handler` when a pointer-down occurs outside the given
 * element. Used to dismiss the cluster and namespace dropdowns (design: menus close
 * on outside click, and only one is open at a time).
 */

import { useEffect, type RefObject } from "react";

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: () => void,
  /** When false, the listener is not attached (e.g. menu already closed). */
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;

    function onPointerDown(e: MouseEvent) {
      const el = ref.current;
      // Ignore clicks inside the referenced element.
      if (el && !el.contains(e.target as Node)) handler();
    }

    // `mousedown` (not `click`) so the menu closes before any inner click resolves.
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [ref, handler, active]);
}
