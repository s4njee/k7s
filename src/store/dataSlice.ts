/**
 * Data slice: live Kubernetes rows, metrics, samples, drains, and settings.
 */

import type { StateCreator } from "zustand";
import type { AppState, DataActions, DataSliceState, RowMap } from "./types";
import { KIND_ORDER } from "../lib/kinds";
import { deriveProblems } from "../lib/problems";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { cachedTheme, prefersDark } from "../lib/theme";
import { EMPTY_SELECTION } from "../lib/selection";
import type { Row } from "../providers/types";

export const NODE_SAMPLE_CAP = 240;
export const POD_SAMPLE_CAP = 240;

/** Empty row map: every built-in kind present with an empty array. */
export function emptyRows(): RowMap {
  return Object.fromEntries(KIND_ORDER.map((k) => [k, [] as Row[]]));
}

/** A copy of `obj` without `key`. */
function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}

// The kinds deriveProblems actually scans (src/lib/problems.ts). Memoising by
// these arrays' identities means a high-rate pods update doesn't re-scan every
// kind's rows when only one array changed (B78).
const PROBLEM_KINDS = ["pods", "nodes", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs", "replicasets"] as const;
let problemsMemoRefs = new Map<string, Row[] | undefined>();
let problemsMemoResult: Row[] = [];

/** `deriveProblems`, but only re-scans when a scanned kind's row array changed. */
function deriveProblemsMemo(rows: RowMap): Row[] {
  const same = PROBLEM_KINDS.every((k) => (rows[k] as Row[] | undefined) === problemsMemoRefs.get(k));
  if (same) return problemsMemoResult;
  problemsMemoRefs = new Map(PROBLEM_KINDS.map((k) => [k, rows[k] as Row[] | undefined]));
  problemsMemoResult = deriveProblems(rows);
  return problemsMemoResult;
}

export const initialDataState: DataSliceState = {
  rows: emptyRows(),
  rowsByCid: {},
  customKinds: [],
  customKindsByCid: {},
  settings: { ...DEFAULT_SETTINGS, theme: cachedTheme() },
  selection: EMPTY_SELECTION,
  selectionByCid: {},
  systemDark: prefersDark(),
  settingsOpen: false,
  createOpen: false,
  paletteOpen: false,
  problemsScope: "active",
  podMetrics: {},
  podMetricsByCid: {},
  nodeMetrics: {},
  nodeMetricsByCid: {},
  portForwards: [],
  portForwardsByCid: {},
  drains: {},
  drainsByCid: {},
  nodeSamples: {},
  nodeSamplesByCid: {},
  nodeStatsErrors: {},
  nodeStatsErrorsByCid: {},
  podSamples: {},
  podSamplesByCid: {},
};

export const createDataSlice: StateCreator<
  AppState,
  [],
  [],
  DataSliceState & DataActions
> = (set) => ({
  ...initialDataState,

  setRows: (cid, kind, rows) =>
    set((s) => {
      const base = s.rowsByCid[cid] ?? emptyRows();
      const nextMap = { ...s.rowsByCid, [cid]: { ...base, [kind]: rows } };
      const patch: Partial<AppState> = { rowsByCid: nextMap };
      if (cid === s.activeCid) {
        // Problems are derived from the row set (B32) — retained per cid too,
        // memoised so a churn of one kind doesn't re-scan them all (B78).
        const next = nextMap[cid];
        patch.rows = { ...next, problems: deriveProblemsMemo(next) };
      }
      return patch;
    }),

  setRowsDelta: (cid, kind, upserts, deletes) =>
    set((s) => {
      const base = s.rowsByCid[cid] ?? emptyRows();
      const current = base[kind] ?? [];
      const upsertByUid = new Map(upserts.map((r) => [r.uid, r]));
      const deleteSet = new Set(deletes);
      // Replace/add by uid, drop deletes — preserving the existing order of
      // untouched rows (B78: a small delta against 10k rows copies ~10k refs,
      // cheap; the win is the wire payload).
      const merged = current
        .map((r) => upsertByUid.get(r.uid) ?? r)
        .filter((r) => !deleteSet.has(r.uid));
      for (const [uid, u] of upsertByUid) {
        if (!current.some((r) => r.uid === uid)) merged.push(u);
      }
      const nextMap = { ...s.rowsByCid, [cid]: { ...base, [kind]: merged } };
      const patch: Partial<AppState> = { rowsByCid: nextMap };
      if (cid === s.activeCid) {
        const next = nextMap[cid];
        patch.rows = { ...next, problems: deriveProblemsMemo(next) };
      }
      return patch;
    }),

  setCustomKinds: (cid, kinds) =>
    set((s) => ({
      customKindsByCid: { ...s.customKindsByCid, [cid]: kinds },
      ...(cid === s.activeCid ? { customKinds: kinds } : {}),
    })),

  setPodMetrics: (cid, m) =>
    set((s) => ({
      podMetricsByCid: { ...s.podMetricsByCid, [cid]: m },
      ...(cid === s.activeCid ? { podMetrics: m } : {}),
    })),

  setNodeMetrics: (cid, m) =>
    set((s) => ({
      nodeMetricsByCid: { ...s.nodeMetricsByCid, [cid]: m },
      ...(cid === s.activeCid ? { nodeMetrics: m } : {}),
    })),

  setPortForwards: (cid, list) =>
    set((s) => ({
      portForwardsByCid: { ...s.portForwardsByCid, [cid]: list },
      ...(cid === s.activeCid ? { portForwards: list } : {}),
    })),

  setDrain: (cid, p) =>
    set((s) => {
      const base = s.drainsByCid[cid] ?? {};
      const nextMap = { ...s.drainsByCid, [cid]: { ...base, [p.node]: p } };
      const patch: Partial<AppState> = { drainsByCid: nextMap };
      if (cid === s.activeCid) patch.drains = nextMap[cid];
      return patch;
    }),

  seedNodeSamples: (cid, node, history) =>
    set((s) => {
      if (history.length === 0) return {};
      const live = (s.nodeSamplesByCid[cid] ?? {})[node] ?? [];
      const oldestLive = live.length ? live[0].ts : Infinity;
      const merged = history.filter((h) => h.ts < oldestLive).concat(live);
      const capped = merged.length > NODE_SAMPLE_CAP ? merged.slice(-NODE_SAMPLE_CAP) : merged;
      const nextMap = {
        ...s.nodeSamplesByCid,
        [cid]: { ...(s.nodeSamplesByCid[cid] ?? {}), [node]: capped },
      };
      const patch: Partial<AppState> = { nodeSamplesByCid: nextMap };
      if (cid === s.activeCid) patch.nodeSamples = nextMap[cid] ?? {};
      return patch;
    }),

  addNodeSample: (cid, node, sample) =>
    set((s) => {
      const base = s.nodeSamplesByCid[cid] ?? {};
      const next = (base[node] ?? []).concat(sample);
      const capped = next.length > NODE_SAMPLE_CAP ? next.slice(-NODE_SAMPLE_CAP) : next;
      const nextMap = { ...s.nodeSamplesByCid, [cid]: { ...base, [node]: capped } };
      const patch: Partial<AppState> = {
        nodeSamplesByCid: nextMap,
        nodeStatsErrorsByCid: {
          ...s.nodeStatsErrorsByCid,
          [cid]: omit(s.nodeStatsErrorsByCid[cid] ?? {}, node),
        },
      };
      if (cid === s.activeCid) {
        patch.nodeSamples = nextMap[cid] ?? {};
        patch.nodeStatsErrors = omit(s.nodeStatsErrors, node);
      }
      return patch;
    }),

  setNodeStatsError: (cid, node, message) =>
    set((s) => {
      const base = s.nodeStatsErrorsByCid[cid] ?? {};
      const nextMap = { ...s.nodeStatsErrorsByCid, [cid]: { ...base, [node]: message } };
      const patch: Partial<AppState> = { nodeStatsErrorsByCid: nextMap };
      if (cid === s.activeCid) patch.nodeStatsErrors = nextMap[cid] ?? {};
      return patch;
    }),

  addPodSample: (cid, key, sample) =>
    set((s) => {
      const base = s.podSamplesByCid[cid] ?? {};
      const next = (base[key] ?? []).concat(sample);
      const capped = next.length > POD_SAMPLE_CAP ? next.slice(-POD_SAMPLE_CAP) : next;
      const nextMap = { ...s.podSamplesByCid, [cid]: { ...base, [key]: capped } };
      const patch: Partial<AppState> = { podSamplesByCid: nextMap };
      if (cid === s.activeCid) patch.podSamples = nextMap[cid] ?? {};
      return patch;
    }),

  setSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      const logBuffer =
        s.logBuffer.length > settings.logBufferCap
          ? s.logBuffer.slice(-settings.logBufferCap)
          : s.logBuffer;
      return { settings, logBuffer };
    }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setCreateOpen: (open) => set({ createOpen: open }),
  setSystemDark: (dark) => set({ systemDark: dark }),
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: EMPTY_SELECTION }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setProblemsScope: (scope) => set({ problemsScope: scope }),

  resetData: (cid) =>
    set((s) => {
      const patch: Partial<AppState> = {
        rowsByCid: omit(s.rowsByCid, cid),
        customKindsByCid: omit(s.customKindsByCid, cid),
        podMetricsByCid: omit(s.podMetricsByCid, cid),
        nodeMetricsByCid: omit(s.nodeMetricsByCid, cid),
        portForwardsByCid: omit(s.portForwardsByCid, cid),
        drainsByCid: omit(s.drainsByCid, cid),
        nodeSamplesByCid: omit(s.nodeSamplesByCid, cid),
        nodeStatsErrorsByCid: omit(s.nodeStatsErrorsByCid, cid),
        podSamplesByCid: omit(s.podSamplesByCid, cid),
        // B74-L: watcher health dies with the cluster, like its rows.
        watcherHealthByCid: omit(s.watcherHealthByCid, cid),
      };
      if (cid === s.activeCid) {
        patch.rows = emptyRows();
        patch.customKinds = [];
        patch.podMetrics = {};
        patch.nodeMetrics = {};
        patch.portForwards = [];
        patch.drains = {};
        patch.nodeSamples = {};
        patch.nodeStatsErrors = {};
        patch.podSamples = {};
        patch.selectedRow = null;
        patch.selection = EMPTY_SELECTION;
        patch.logBuffer = [];
        patch.clusterStatus = null;
        patch.watcherHealth = {};
        patch.openMenu = null;
      }
      return patch;
    }),
});
