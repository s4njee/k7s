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

export const initialDataState: DataSliceState = {
  rows: emptyRows(),
  customKinds: [],
  settings: { ...DEFAULT_SETTINGS, theme: cachedTheme() },
  selection: EMPTY_SELECTION,
  systemDark: prefersDark(),
  settingsOpen: false,
  createOpen: false,
  paletteOpen: false,
  podMetrics: {},
  nodeMetrics: {},
  portForwards: [],
  drains: {},
  nodeSamples: {},
  nodeStatsErrors: {},
  podSamples: {},
};

export const createDataSlice: StateCreator<
  AppState,
  [],
  [],
  DataSliceState & DataActions
> = (set) => ({
  ...initialDataState,

  setRows: (kind, rows) =>
    set((s) => {
      const next = { ...s.rows, [kind]: rows };
      return { rows: { ...next, problems: deriveProblems(next) } };
    }),

  setCustomKinds: (kinds) => set({ customKinds: kinds }),
  setPodMetrics: (m) => set({ podMetrics: m }),
  setNodeMetrics: (m) => set({ nodeMetrics: m }),
  setPortForwards: (list) => set({ portForwards: list }),
  setDrain: (p) => set((s) => ({ drains: { ...s.drains, [p.node]: p } })),

  seedNodeSamples: (node, history) =>
    set((s) => {
      if (history.length === 0) return {};
      const live = s.nodeSamples[node] ?? [];
      const oldestLive = live.length ? live[0].ts : Infinity;
      const merged = history.filter((h) => h.ts < oldestLive).concat(live);
      return {
        nodeSamples: {
          ...s.nodeSamples,
          [node]: merged.length > NODE_SAMPLE_CAP ? merged.slice(-NODE_SAMPLE_CAP) : merged,
        },
      };
    }),

  addNodeSample: (node, sample) =>
    set((s) => {
      const next = (s.nodeSamples[node] ?? []).concat(sample);
      return {
        nodeSamples: {
          ...s.nodeSamples,
          [node]: next.length > NODE_SAMPLE_CAP ? next.slice(-NODE_SAMPLE_CAP) : next,
        },
        nodeStatsErrors: omit(s.nodeStatsErrors, node),
      };
    }),

  setNodeStatsError: (node, message) =>
    set((s) => ({ nodeStatsErrors: { ...s.nodeStatsErrors, [node]: message } })),

  addPodSample: (key, sample) =>
    set((s) => {
      const next = (s.podSamples[key] ?? []).concat(sample);
      return {
        podSamples: {
          ...s.podSamples,
          [key]: next.length > POD_SAMPLE_CAP ? next.slice(-POD_SAMPLE_CAP) : next,
        },
      };
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

  resetData: () =>
    set({
      rows: emptyRows(),
      customKinds: [],
      podMetrics: {},
      nodeMetrics: {},
      portForwards: [],
      drains: {},
      nodeSamples: {},
      nodeStatsErrors: {},
      podSamples: {},
      selectedRow: null,
      selection: EMPTY_SELECTION,
      logBuffer: [],
      clusterStatus: null,
      openMenu: null,
    }),
});
