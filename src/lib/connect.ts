/**
 * Shared connect flow used by both the initial bootstrap and the cluster
 * switcher. Sets the UI to "connecting", clears any previous cluster's data, then
 * connects and records the result (or a friendly error on failure).
 *
 * The real backend re-emits fresh resource snapshots when its watchers start; the
 * MockProvider re-emits on `connect()` — so clearing data here is safe for both.
 */

import { getProvider } from "../providers";
import { useStore } from "../store";
import { errDisplay } from "./errors";

export async function connectTo(context: string): Promise<void> {
  const provider = getProvider();
  const store = useStore.getState();

  // Switch the UI to this cluster (retained data shows instantly — B77); the
  // backend reuses a live connection or starts one, so nothing is torn down.
  store.setActiveCid(context);
  // Apply the per-cluster default namespace (B77) when one is set.
  const ns = store.clusterNamespaces[context];
  if (ns) store.setNamespace(ns);
  store.setConnection(context, {
    phase: "connecting",
    context,
    clusterName: context,
    error: undefined,
  });

  try {
    const info = await provider.connect(context);
    store.setConnection(context, {
      phase: "connected",
      context: info.context,
      clusterName: info.clusterName,
      error: undefined,
    });
  } catch (e) {
    store.setConnection(context, {
      phase: "error",
      error: errDisplay(e),
    });
  }
}
