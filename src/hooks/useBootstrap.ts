/**
 * App bootstrap hook: subscribes the store to the data provider's push events and
 * kicks off the initial connection. Mounted once at the app root.
 *
 * Kept provider-agnostic — it works identically for MockProvider (demo) and
 * TauriProvider (real cluster). The subscriptions are torn down on unmount so a
 * hot reload or window close doesn't leak listeners.
 */

import { useEffect } from "react";
import { getProvider, IS_DEMO } from "../providers";
import { useStore } from "../store";
import { connectTo } from "../lib/connect";
import { KIND_META } from "../lib/kinds";

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

    // Discover contexts, restore saved preferences, then connect (B11).
    setConnection({ phase: "connecting" });
    void (async () => {
      try {
        const contexts = await provider.listContexts();
        setContexts(contexts);

        // Restore last nav/namespace/timestamps before connecting.
        const prefs = await provider.loadPrefs();
        if (prefs) {
          const restore: Partial<ReturnType<typeof useStore.getState>> = {};
          if (prefs.nav && prefs.nav in KIND_META) restore.nav = prefs.nav;
          if (typeof prefs.namespace === "string") restore.namespace = prefs.namespace;
          if (typeof prefs.showTimestamps === "boolean") restore.showTimestamps = prefs.showTimestamps;
          if (Object.keys(restore).length) useStore.setState(restore);
        }

        // Prefer the saved context if it still exists, else the current-context.
        const saved = prefs?.context ? contexts.find((c) => c.name === prefs.context) : undefined;
        const target = saved ?? contexts.find((c) => c.current) ?? contexts[0];
        if (!target) {
          setConnection({ phase: "error", error: "no kubeconfig contexts found" });
          return;
        }
        await connectTo(target.name);
      } catch (e) {
        setConnection({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      }
    })();

    // Persist relevant state changes (debounced). No-op in demo mode.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSaved = "";
    const unsubSave = IS_DEMO
      ? () => {}
      : useStore.subscribe((s) => {
          const prefs = {
            context: s.connection.context,
            nav: s.nav,
            namespace: s.namespace,
            showTimestamps: s.showTimestamps,
          };
          const key = JSON.stringify(prefs);
          if (key === lastSaved) return;
          lastSaved = key;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => void provider.savePrefs(prefs), 500);
        });

    return () => {
      for (const off of unsubs) off();
      unsubSave();
      clearTimeout(saveTimer);
    };
    // Empty deps: run exactly once for the app's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
