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

export async function connectTo(context: string): Promise<void> {
  const provider = getProvider();
  const store = useStore.getState();

  // Enter the connecting state and wipe the previous cluster's rows/metrics/etc.
  store.setConnection({ phase: "connecting", context, error: undefined });
  store.resetData();

  try {
    const info = await provider.connect(context);
    store.setConnection({
      phase: "connected",
      context: info.context,
      clusterName: info.clusterName,
      error: undefined,
    });
  } catch (e) {
    store.setConnection({
      phase: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
