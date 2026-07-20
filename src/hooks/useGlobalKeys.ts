/**
 * App-level keyboard shortcuts (B10, B28):
 *   ⌘K / ⌃K  open the command palette
 *   :        the same, in the k9s idiom (ignored while typing)
 *   Esc      cascade — close the palette, else a menu, else clear the filter,
 *            else close the detail panel
 *   [ / ]    cycle the detail panel's tabs (when a row is selected)
 *
 * Esc works even while typing (so it can clear the filter field); the other keys
 * are ignored there, or `:` would be unusable in a filter.
 */

import { useEffect } from "react";
import { useStore } from "../store";
import { isTypingTarget } from "../lib/dom";
import { tabsFor } from "../lib/kinds";

export function useGlobalKeys(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = useStore.getState();
      const typing = isTypingTarget(document.activeElement);

      // ⌘K is the near-universal binding for this; ⌃K covers non-Mac habits.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }

      // k9s muscle memory. Only outside a text field — it's a legal character.
      if (e.key === ":" && !typing && !s.paletteOpen) {
        e.preventDefault();
        s.setPaletteOpen(true);
        return;
      }

      if (e.key === "Escape") {
        // The palette handles its own Escape (and stops it here), so that closing
        // it doesn't also clear the filter underneath. This is the fallback for
        // when focus has escaped the input.
        if (s.paletteOpen) s.setPaletteOpen(false);
        else if (s.openMenu) s.closeMenus();
        // A multi-row selection outranks the filter and the panel (B39): it's
        // the most recent thing you did, it's armed for a destructive action,
        // and there is otherwise no keyboard way to stand it down.
        // (An open row context menu consumes Escape itself, so it closes first.)
        else if (s.selection.selected.length > 1) s.clearSelection();
        else if (s.tableFilter) s.setTableFilter("");
        else if (s.selectedRow) s.closeDetail();
        return;
      }

      if ((e.key === "[" || e.key === "]") && s.selectedRow && !typing) {
        // Cycle the tabs this kind actually has. The list is shared with the tab
        // strip (lib/kinds.ts) — when it was duplicated here, it drifted, and
        // cycling landed on tabs that no longer existed.
        const tabs = tabsFor(s.nav, !!s.selectedRow.pod);
        if (tabs.length === 0) return;
        const i = Math.max(0, tabs.indexOf(s.activeTab));
        const next = e.key === "]" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
        s.setActiveTab(tabs[next]);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
