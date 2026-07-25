/**
 * Per-pod usage sampling for the Metrics tab.
 *
 * Unlike a node's node-exporter scraper (see useNodeStats), this starts no new
 * data source: the cluster-wide metrics poller is already running and feeding the
 * pod list. `watchPodStats` only tells the provider to forward that pod's samples
 * through `onPodStats`, which the bootstrap wires into the store.
 *
 * Mounted by the Metrics tab, so unmounting it (closing the panel, switching tab,
 * selecting another pod) stops the forwarding via the effect's cleanup.
 */

import { useEffect } from "react";
import { getProvider } from "../providers";
import { useStore } from "../store";

export function usePodStats(key: string | undefined): void {
  const phase = useStore((s) => s.connection.phase);

  useEffect(() => {
    if (!key || phase !== "connected") return;

    const provider = getProvider();
    void provider.watchPodStats(key).catch(() => {
      // Best-effort: there's nothing to fail in real mode (it only registers a
      // key), and an empty series shows its own "waiting" state either way.
    });

    return () => {
      void provider.unwatchPodStats(key).catch(() => {});
    };
  }, [key, phase]);
}
