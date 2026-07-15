/**
 * App bootstrap hook: subscribes the store to the data provider's push events and
 * kicks off the initial connection. Mounted once at the app root.
 *
 * Kept provider-agnostic — it works identically for MockProvider (demo) and
 * TauriProvider (real cluster). The subscriptions are torn down on unmount so a
 * hot reload or window close doesn't leak listeners.
 */

import { useEffect } from "react";
import { getProvider } from "../providers";
import { useStore } from "../store";
import { connectTo } from "../lib/connect";

export function useBootstrap(): void {
  useEffect(() => {
    const provider = getProvider();
    const {
      setRows,
      setPodMetrics,
      setNodeMetrics,
      setClusterStatus,
      setWatchCount,
      setConnection,
      setContexts,
    } = useStore.getState();

    // Reconcile cluster-status into the connection lifecycle (Story 6.2): a live
    // cluster going unreachable flips the UI to disconnected, and recovery flips it
    // back — without a manual reconnect. Also clears stale metrics when the metrics
    // API disappears (cpuPercent goes null) so CPU/MEM fall back to "—".
    const onClusterStatus = (status: Parameters<typeof setClusterStatus>[0]) => {
      setClusterStatus(status);
      const { connection, setConnection, setPodMetrics: setPM, setNodeMetrics: setNM } =
        useStore.getState();
      if (connection.phase === "connected" && !status.connected) {
        setConnection({ phase: "error", error: "cluster unreachable" });
      } else if (connection.phase === "error" && status.connected) {
        setConnection({ phase: "connected", error: undefined });
      }
      if (status.cpuPercent == null) {
        // metrics-server gone: drop cached usage so nothing stale lingers.
        setPM({});
        setNM({});
      }
    };

    // Wire every push channel to its store setter. Each returns an unsubscribe fn.
    const unsubs = [
      provider.onResourceUpdate(setRows),
      provider.onPodMetrics(setPodMetrics),
      provider.onNodeMetrics(setNodeMetrics),
      provider.onClusterStatus(onClusterStatus),
      provider.onWatchStatus(setWatchCount),
    ];

    // Discover contexts, then connect to the current one (instant in demo mode).
    setConnection({ phase: "connecting" });
    void (async () => {
      try {
        const contexts = await provider.listContexts();
        setContexts(contexts);
        const current = contexts.find((c) => c.current) ?? contexts[0];
        if (!current) {
          setConnection({ phase: "error", error: "no kubeconfig contexts found" });
          return;
        }
        await connectTo(current.name);
      } catch (e) {
        setConnection({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      for (const off of unsubs) off();
    };
    // Empty deps: run exactly once for the app's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
