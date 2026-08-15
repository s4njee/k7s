/**
 * Component-test bootstrap (B83).
 *
 * Component tests run the same demo-mode stack the real app does: `getProvider()`
 * returns MockProvider whenever `!isTauri()` (true in jsdom), so a test that
 * subscribes the store the way `useBootstrap` does gets live demo data — 3
 * clusters, per-cluster pods, log streams, YAML, events — with zero mocking.
 *
 * `subscribeProvider` mirrors the push-channel wiring in
 * `src/hooks/useBootstrap.ts`; `connectAll` connects a set of demo contexts
 * through the real `connectTo` flow. Use the pair like this:
 *
 *   let off: (() => void) | undefined;
 *   beforeEach(() => { off?.(); resetStore(); off = subscribeProvider(); });
 *   afterAll(() => off?.());
 *   await connectAll(["freya", "odin-staging"]);
 */

import { getProvider } from "../providers";
import { useStore } from "../store";
import { connectTo } from "../lib/connect";

/** The demo clusters MockProvider offers (freya is current at boot). */
export const DEMO_CLUSTERS = ["freya", "odin-staging", "loki-dev"];

/**
 * Wire the active provider's push channels to the store, exactly as useBootstrap
 * does. Returns an unsubscribe so tests can tear down between cases (the
 * MockProvider singleton keeps its callbacks across resets otherwise).
 */
export function subscribeProvider(): () => void {
  const provider = getProvider();
  const {
    setRows,
    setRowsDelta,
    setPodMetrics,
    setNodeMetrics,
    setClusterStatus,
    setWatchCount,
    setWatcherHealth,
    setCustomKinds,
    setPortForwards,
    setDrain,
    addNodeSample,
    setNodeStatsError,
    addPodSample,
  } = useStore.getState();

  const offs = [
    provider.onResourceUpdate((cid, kind, update) => {
      if ("rows" in update) setRows(cid, kind, update.rows);
      else setRowsDelta(cid, kind, update.upserts, update.deletes);
    }),
    provider.onPodMetrics(setPodMetrics),
    provider.onNodeMetrics(setNodeMetrics),
    // B74-L: a stale probe marks the cluster stale rather than flipping phase.
    provider.onClusterStatus((cid, status) => {
      setClusterStatus(cid, status);
      const { setPodMetrics: setPM, setNodeMetrics: setNM } = useStore.getState();
      if (status.cpuPercent == null) {
        setPM(cid, {});
        setNM(cid, {});
      }
    }),
    provider.onWatchStatus(setWatchCount),
    provider.onWatcherHealth(setWatcherHealth),
    provider.onCustomKinds(setCustomKinds),
    provider.onForwards(setPortForwards),
    provider.onDrainProgress(setDrain),
    provider.onNodeStats(addNodeSample),
    provider.onNodeStatsError((cid, e) => setNodeStatsError(cid, e.node, e.message)),
    provider.onPodStats(addPodSample),
  ];
  return () => offs.forEach((off) => off());
}

/** Reset the store to its pristine initial state (Zustand singleton). */
export function resetStore(): void {
  useStore.setState(useStore.getInitialState());
}

/**
 * Discover the given contexts and connect each through the real `connectTo`
 * flow, so connections, rows, status, and watcher health all land as they do in
 * the app. Await it in the test before rendering.
 */
export async function connectAll(contexts: string[]): Promise<void> {
  // The context list is always the full demo set (like the app's discovery);
  // `contexts` is which of them get connected in this test.
  useStore.getState().setContexts(
    DEMO_CLUSTERS.map((name, i) => ({ name, cluster: name, current: i === 0 })),
  );
  for (const name of contexts) await connectTo(name);
  // connectTo leaves the *last* context active; the app boots on the current
  // (first) one, so restore that as the active view. Every cluster's data is
  // already retained, so this is just re-pointing the active slices.
  if (contexts.length > 1) useStore.getState().setActiveCid(contexts[0]);
}
