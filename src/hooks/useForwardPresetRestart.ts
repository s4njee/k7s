/**
 * Forward-preset restart after reconnect (B89): when a cluster transitions from
 * stale back to live, start each of that cluster's presets with `autoRestart`
 * opted in. Frontend-only — the backend never auto-restarts forwards.
 *
 * Watches the stale→fresh edge (the same signal the status bar uses): a plain
 * staleness recovery doesn't change the connection phase, so this can't hook the
 * phase transition alone.
 */

import { useEffect } from "react";
import { useStore } from "../store";
import { getProvider } from "../providers";

export function useForwardPresetRestart(): void {
  useEffect(() => {
    // Previous stale state per cid, so only the true→false edge fires.
    let prev = new Map<string, boolean>();

    const check = () => {
      const s = useStore.getState();
      const now = new Map<string, boolean>();
      for (const [cid, status] of Object.entries(s.clusterStatusByCid)) {
        now.set(cid, status?.stale ?? false);
      }
      for (const [cid, wasStale] of prev) {
        if (wasStale && now.get(cid) === false) {
          for (const p of s.forwardPresetsByCid[cid] ?? []) {
            if (!p.autoRestart) continue;
            void getProvider()
              .startPortForward({ kind: p.kind, namespace: p.namespace, name: p.target }, p.remotePort, p.localPort)
              .then(async () => {
                useStore.getState().setPortForwards(cid, await getProvider().listPortForwards());
              })
              .catch(() => {
                // A preset that fails to restart stays listed; the user can retry.
              });
          }
        }
      }
      prev = now;
    };

    const unsub = useStore.subscribe(check);
    check();
    return unsub;
  }, []);
}
