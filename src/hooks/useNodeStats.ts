/**
 * Lazy node-exporter scraping (B27).
 *
 * The rule is the same one that governs CRD watchers: *the node whose Metrics tab
 * is open is scraped, and nothing else is*. Each scrape moves a few hundred KB
 * and holds a port-forward open, so this is not something to run for every node
 * in the background.
 *
 * Mounted by the Metrics tab, so unmounting it (closing the panel, switching tab,
 * selecting another node) tears the scraper down via the effect's cleanup.
 */

import { useEffect } from "react";
import { getProvider } from "../providers";
import { useStore } from "../store";

export function useNodeStats(node: string | undefined): void {
  const phase = useStore((s) => s.connection.phase);

  useEffect(() => {
    if (!node || phase !== "connected") return;

    const provider = getProvider();
    let cancelled = false;
    void provider.watchNodeStats(node).catch((e) => {
      // Non-fatal: the tab shows why it has no plots. The backend reports most
      // failures (no exporter, forward refused) through onNodeStatsError instead,
      // since they happen after this call has returned.
      if (!cancelled) {
        useStore.getState().setNodeStatsError(node, e instanceof Error ? e.message : String(e));
      }
    });

    return () => {
      cancelled = true;
      void provider.unwatchNodeStats(node).catch(() => {
        // Best-effort: the backend also drops scrapers on reset.
      });
    };
  }, [node, phase]);
}
