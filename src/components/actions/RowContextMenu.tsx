/**
 * Right-click menu for table rows (B39).
 *
 * All it adds to {@link ActionList} is placement, which is the one thing the two
 * action surfaces genuinely can't share: this one follows the mouse.
 *
 * Rendered through a portal to `document.body`. The table scrolls and clips its
 * own content, so a menu positioned inside it would be cut off at the viewport
 * edge or trapped under a later stacking context — the classic context-menu bug
 * where right-clicking the bottom row shows you half a menu.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionList } from "./ActionList";
import type { KindId, Row } from "../../providers/types";

export interface ContextMenuAt {
  x: number;
  y: number;
}

interface RowContextMenuProps {
  at: ContextMenuAt;
  kind: KindId;
  rows: Row[];
  onError: (msg: string | null) => void;
  onClose: () => void;
  onGone: () => void;
  /**
   * The element whose scrolling moves the row this menu points at.
   *
   * Required rather than inferred: a capture-phase `scroll` listener on window
   * sees scrolls from *every* element in the app, and the detail panel's log view
   * auto-scrolls continuously — which closed this menu within milliseconds of it
   * opening. Scrolling the table should dismiss the menu; a log line arriving
   * somewhere else should not.
   */
  scrollHost?: HTMLElement | null;
}

/** Keep the menu on screen: flip it up/left when it would overflow. */
function place(at: ContextMenuAt, size: { w: number; h: number }): { left: number; top: number } {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Flip rather than clamp: a menu that merely butts against the edge would sit
  // under the cursor and swallow the next click.
  const left = at.x + size.w + margin > vw ? Math.max(margin, at.x - size.w) : at.x;
  const top = at.y + size.h + margin > vh ? Math.max(margin, at.y - size.h) : at.y;
  return { left, top };
}

export function RowContextMenu({
  at,
  kind,
  rows,
  onError,
  onClose,
  onGone,
  scrollHost,
}: RowContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Placed after the first paint, once the real size is known — the menu's height
  // depends on how many actions the kind has, so it can't be guessed up front.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: at.x, top: at.y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(place(at, { w: r.width, h: r.height }));
  }, [at]);

  // Dismissal. `mousedown` rather than `click` so the menu is gone before the
  // click lands underneath it, and capture-phase scroll so scrolling the table
  // (which would leave the menu pointing at a different row) closes it too.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Consumed here, so Escape closes only the menu and doesn't also run the
        // app-wide cascade behind it (which would clear the selection too).
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    // Capture: the app's own Escape handler is on document and would otherwise
    // fire in the same dispatch.
    document.addEventListener("keydown", onKey, true);
    // Scoped to the table's scroller only — see `scrollHost`.
    scrollHost?.addEventListener("scroll", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      scrollHost?.removeEventListener("scroll", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, scrollHost]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 300 }}
      // A right-click on the menu itself shouldn't open the browser's own menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      <ActionList
        kind={kind}
        rows={rows}
        onError={onError}
        onClose={onClose}
        onGone={onGone}
      />
    </div>,
    document.body,
  );
}
