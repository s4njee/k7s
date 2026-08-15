/**
 * Detail panel slice: selected row, active tab, log streaming, and YAML editing.
 */

import type { StateCreator } from "zustand";
import type { AppState, DetailActions, DetailSliceState, DetailState } from "./types";
import { selectionPatch } from "./navigationSlice";

/** The default detail-panel fields (used for a cid with no retained state). */
export function defaultDetailState(): DetailState {
  return {
    selectedRow: null,
    activeTab: "logs",
    logSearch: "",
    containerIndex: 0,
    showTimestamps: true,
    following: true,
    logBuffer: [],
    logPrevious: false,
    logSince: "all",
    yamlEditing: false,
    yamlDraft: "",
  };
}

export const initialDetailState: DetailSliceState = {
  ...defaultDetailState(),
  detailByCid: {},
};

export const createDetailSlice: StateCreator<
  AppState,
  [],
  [],
  DetailSliceState & DetailActions
> = (set) => ({
  ...initialDetailState,

  selectRow: (row) => set((s) => selectionPatch(row, s.nav)),
  closeDetail: () => set({ selectedRow: null }),
  setActiveTab: (tab) => set({ activeTab: tab, yamlEditing: false }),

  // ---------- logs ----------
  setLogSearch: (q) => set({ logSearch: q }),
  cycleContainer: () =>
    set((s) => ({ containerIndex: s.containerIndex + 1, logBuffer: [] })),
  toggleTimestamps: () => set((s) => ({ showTimestamps: !s.showTimestamps })),
  toggleFollow: () => set((s) => ({ following: !s.following })),
  setFollowing: (value) => set({ following: value }),
  setLogPrevious: (value) => set({ logPrevious: value, logBuffer: [] }),
  setLogSince: (value) => set({ logSince: value, logBuffer: [] }),
  appendLogs: (lines) =>
    set((s) => {
      const cap = s.settings.logBufferCap;
      const next = s.logBuffer.concat(lines);
      return { logBuffer: next.length > cap ? next.slice(-cap) : next };
    }),
  clearLogs: () => set({ logBuffer: [] }),

  // ---------- yaml ----------
  startYamlEdit: (initial) => set({ yamlEditing: true, yamlDraft: initial }),
  cancelYaml: () => set({ yamlEditing: false }),
  setYamlDraft: (text) => set({ yamlDraft: text }),
});
