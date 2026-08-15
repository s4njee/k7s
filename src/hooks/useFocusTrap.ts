/**
 * Focus trap for modals and dialogs (B84).
 *
 * While `active`, focus is moved into `ref` and Tab is trapped within it;
 * on close (active → false, or unmount) focus returns to the element that
 * opened the dialog. This is what makes the "modal focus returns to the
 * invoking control" acceptance hold for every dialog that uses it.
 *
 * Initial focus: `ref.current` itself (made focusable with tabindex="-1", so a
 * screen reader announces the role="dialog" + aria-labelledby), unless an
 * `initialFocusRef` is given (the palette focuses its own input).
 */

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    // Remember who opened the dialog so focus can return on close.
    openerRef.current = document.activeElement as HTMLElement | null;

    // Initial focus: the requested element (the palette's input), else the
    // dialog container itself — made focusable with tabindex="-1" so a screen
    // reader announces the role="dialog" + aria-labelledby on entry.
    const target = initialFocusRef?.current;
    if (target) {
      target.focus();
    } else {
      const wasTabIndex = el.tabIndex;
      el.tabIndex = -1;
      el.focus();
      if (wasTabIndex >= 0) el.tabIndex = wasTabIndex;
    }

    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (!el.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Document-level: catches Tab even if focus briefly escapes the dialog.
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      openerRef.current?.focus?.();
      openerRef.current = null;
    };
  }, [ref, active, initialFocusRef]);
}
