/**
 * Connection and cluster context state and actions (B77).
 *
 * The store keeps per-cluster retention maps (`connections`, `clusterStatusByCid`,
 * `rowsByCid`, …) plus *active* slices (`connection`, `clusterStatus`, `rows`, …)
 * that always reflect `activeCid`. `setActiveCid` swaps the active slices to the
 * target cluster's retained state — that's what makes switching instant: no data
 * is torn down, every panel just re-points at the selected cluster's data.
 */

import type { StateCreator } from "zustand";
import type { AppState, ConnectionActions, ConnectionSliceState } from "./types";
import { getProvider } from "../providers";
import { sameBookmark } from "../lib/bookmarks";
import { EMPTY_SELECTION } from "../lib/selection";
import { emptyRows } from "./dataSlice";
import { defaultDetailState } from "./detailSlice";

export const initialConnectionState: ConnectionSliceState = {
  activeCid: null,
  connections: {},
  connection: { phase: "idle", context: null, clusterName: null },
  clusterStatusByCid: {},
  clusterStatus: null,
  watchCountByCid: {},
  watchCount: 0,
  watcherHealthByCid: {},
  watcherHealth: {},
  contexts: [],
  importedFiles: [],
  bookmarksByContext: {},
  clusterColors: {},
  clusterNamespaces: {},
};

export const createConnectionSlice: StateCreator<
  AppState,
  [],
  [],
  ConnectionSliceState & ConnectionActions
> = (set, get) => ({
  ...initialConnectionState,

  /**
   * Switch the UI to another cluster: save the outgoing cluster's view state
   * (nav, namespace, selection, detail) into its retention, then restore the
   * incoming cluster's state across every slice. Data already flows into each
   * cid's retention via the cluster setters, so background clusters stay current.
   */
  setActiveCid: (cid) =>
    set((s) => {
      if (cid === s.activeCid) return s;
      const old = s.activeCid;
      const restoredDetail = s.detailByCid[cid] ?? defaultDetailState();
      // The outgoing cluster's detail-panel fields, for its retention slot.
      const detail = {
        selectedRow: s.selectedRow,
        activeTab: s.activeTab,
        logSearch: s.logSearch,
        containerIndex: s.containerIndex,
        showTimestamps: s.showTimestamps,
        following: s.following,
        logBuffer: s.logBuffer,
        logPrevious: s.logPrevious,
        logSince: s.logSince,
        yamlEditing: s.yamlEditing,
        yamlDraft: s.yamlDraft,
      };
      return {
        activeCid: cid,
        // Save the outgoing view state.
        navByCid: old != null ? { ...s.navByCid, [old]: s.nav } : s.navByCid,
        namespaceByCid: old != null ? { ...s.namespaceByCid, [old]: s.namespace } : s.namespaceByCid,
        selectionByCid: old != null ? { ...s.selectionByCid, [old]: s.selection } : s.selectionByCid,
        detailByCid: old != null ? { ...s.detailByCid, [old]: detail } : s.detailByCid,
        // Restore the incoming cluster's state.
        nav: s.navByCid[cid] ?? "overview",
        namespace: s.namespaceByCid[cid] ?? "all",
        selection: s.selectionByCid[cid] ?? EMPTY_SELECTION,
        ...restoredDetail,
        connection: s.connections[cid] ?? { phase: "idle", context: cid, clusterName: cid },
        clusterStatus: s.clusterStatusByCid[cid] ?? null,
        watchCount: s.watchCountByCid[cid] ?? 0,
        watcherHealth: s.watcherHealthByCid[cid] ?? {},
        rows: s.rowsByCid[cid] ?? emptyRows(),
        customKinds: s.customKindsByCid[cid] ?? [],
        podMetrics: s.podMetricsByCid[cid] ?? {},
        nodeMetrics: s.nodeMetricsByCid[cid] ?? {},
        portForwards: s.portForwardsByCid[cid] ?? [],
        drains: s.drainsByCid[cid] ?? {},
        nodeSamples: s.nodeSamplesByCid[cid] ?? {},
        nodeStatsErrors: s.nodeStatsErrorsByCid[cid] ?? {},
        podSamples: s.podSamplesByCid[cid] ?? {},
      };
    }),

  setConnection: (cid, c) =>
    set((s) => {
      if (!cid) {
        // Boot error before any cluster is active: only the active field.
        return { connection: { ...s.connection, ...c } };
      }
      const next = { ...(s.connections[cid] ?? { phase: "idle", context: cid, clusterName: cid }), ...c };
      const patch: Partial<AppState> = { connections: { ...s.connections, [cid]: next } };
      if (cid === s.activeCid) patch.connection = next;
      return patch;
    }),

  setContexts: (contexts) => set({ contexts }),
  setImportedFiles: (paths) => set({ importedFiles: paths }),

  addImportedFile: (path) =>
    set((s) =>
      s.importedFiles.includes(path) ? s : { importedFiles: [...s.importedFiles, path] },
    ),

  addBookmark: (bookmark) =>
    set((s) => {
      const ctx = s.activeCid ?? "";
      const list = s.bookmarksByContext[ctx] ?? [];
      if (list.some((b) => sameBookmark(b, bookmark))) return s;
      return {
        bookmarksByContext: { ...s.bookmarksByContext, [ctx]: [...list, bookmark] },
      };
    }),

  removeBookmark: (bookmark) =>
    set((s) => {
      const ctx = s.activeCid ?? "";
      const list = s.bookmarksByContext[ctx] ?? [];
      const next = list.filter((b) => !sameBookmark(b, bookmark));
      if (next.length === list.length) return s;
      return { bookmarksByContext: { ...s.bookmarksByContext, [ctx]: next } };
    }),

  toggleBookmark: (bookmark) =>
    set((s) => {
      const ctx = s.activeCid ?? "";
      const list = s.bookmarksByContext[ctx] ?? [];
      if (list.some((b) => sameBookmark(b, bookmark))) {
        return {
          bookmarksByContext: {
            ...s.bookmarksByContext,
            [ctx]: list.filter((b) => !sameBookmark(b, bookmark)),
          },
        };
      }
      return {
        bookmarksByContext: { ...s.bookmarksByContext, [ctx]: [...list, bookmark] },
      };
    }),

  setClusterColor: (cid, color) =>
    set((s) => ({ clusterColors: { ...s.clusterColors, [cid]: color } })),
  setClusterNamespace: (cid, ns) =>
    set((s) => ({ clusterNamespaces: { ...s.clusterNamespaces, [cid]: ns } })),

  setClusterStatus: (cid, status) =>
    set((s) => ({
      clusterStatusByCid: { ...s.clusterStatusByCid, [cid]: status },
      ...(cid === s.activeCid ? { clusterStatus: status } : {}),
    })),

  setWatchCount: (cid, n) =>
    set((s) => ({
      watchCountByCid: { ...s.watchCountByCid, [cid]: n },
      ...(cid === s.activeCid ? { watchCount: n } : {}),
    })),

  // Per-kind watcher health (B74-L): the whole map for a cid arrives on any
  // change, retained like every other cid-keyed slice.
  setWatcherHealth: (cid, health) =>
    set((s) => ({
      watcherHealthByCid: { ...s.watcherHealthByCid, [cid]: health },
      ...(cid === s.activeCid ? { watcherHealth: health } : {}),
    })),

  // Retry actions (B74-L): imperative, so they live in the store but delegate to
  // whatever provider is active. Nothing is torn down — retained rows stay.
  retryKind: (kind) => {
    const cid = get().activeCid;
    if (cid) void getProvider().retryKind(cid, kind);
  },
  retryCluster: () => {
    const cid = get().activeCid;
    if (cid) void getProvider().retryCluster(cid);
  },
});
