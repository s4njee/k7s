/**
 * App-level keyboard shortcuts (B10):
 *   Esc     cascade — close an open menu, else clear the filter, else close detail
 *   [ / ]   cycle the detail panel's tabs (when a row is selected)
 *
 * Esc works even while typing (so it can blur/clear the filter); the tab-cycle
 * keys are ignored while typing.
 */

import { useEffect } from "react";
import { useStore, type DetailTab } from "../store";
import { isTypingTarget } from "../lib/dom";

export function useGlobalKeys(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = useStore.getState();

      if (e.key === "Escape") {
        if (s.openMenu) s.closeMenus();
        else if (s.tableFilter) s.setTableFilter("");
        else if (s.selectedRow) s.closeDetail();
        return;
      }

      if ((e.key === "[" || e.key === "]") && s.selectedRow && !isTypingTarget(document.activeElement)) {
        // Cycle among the tabs available for this row (pods also have Logs).
        const tabs: DetailTab[] = s.selectedRow.pod
          ? ["logs", "properties", "shell", "yaml", "events"]
          : ["yaml", "events"];
        const i = Math.max(0, tabs.indexOf(s.activeTab));
        const next = e.key === "]" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
        s.setActiveTab(tabs[next]);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
