/**
 * Central application store (Zustand). Holds exactly the state enumerated in the
 * design handoff's "State Management" section plus the live data streamed in from
 * the provider. UI components subscribe to slices of this; provider event handlers
 * (wired in app bootstrap) call the setters.
 */

import { create } from "zustand";
import type {
  ClusterStatus,
  ContextInfo,
  LogLine,
  NodeMetricsMap,
  PodMetricsMap,
  Row,
} from "./providers/types";
import { KIND_ORDER, type ResourceKind } from "./lib/kinds";

/** Ring-buffer cap for the log view (design default). */
export const LOG_BUFFER_CAP = 200;

/** Detail-panel tab identifiers. */
export type DetailTab = "logs" | "yaml" | "events";

/** Which dropdown menu (if any) is currently open — only one at a time. */
export type OpenMenu = "cluster" | "ns" | null;

/** Connection lifecycle for the active cluster/context. */
export interface ConnectionState {
  phase: "idle" | "connecting" | "connected" | "error";
  /** kubeconfig context name currently selected. */
  context: string | null;
  /** Cluster display name (from connect result). */
  clusterName: string | null;
  /** Error message when phase === "error". */
  error?: string;
}

/** Empty per-kind row map (all 12 kinds present, each an empty array). */
function emptyRows(): Record<ResourceKind, Row[]> {
  return Object.fromEntries(KIND_ORDER.map((k) => [k, [] as Row[]])) as Record<
    ResourceKind,
    Row[]
  >;
}

export interface AppState {
  // ---------- connection & cluster ----------
  connection: ConnectionState;
  clusterStatus: ClusterStatus | null;
  watchCount: number;
  /** Available kubeconfig contexts (cluster switcher entries). */
  contexts: ContextInfo[];

  // ---------- navigation & filtering ----------
  /** Active resource kind (drives the table + breadcrumb). */
  nav: ResourceKind;
  /** Namespace filter; "all" shows everything. */
  namespace: string;
  /** Free-text name filter for the current table (cleared on nav change). */
  tableFilter: string;
  /** Which dropdown is open (cluster switcher or ns menu). */
  openMenu: OpenMenu;

  // ---------- live data ----------
  rows: Record<ResourceKind, Row[]>;
  podMetrics: PodMetricsMap;
  nodeMetrics: NodeMetricsMap;

  // ---------- pod detail panel ----------
  /** Selected pod row (null → panel closed). */
  selectedPod: Row | null;
  activeTab: DetailTab;

  // logs tab
  logSearch: string;
  containerIndex: number;
  showTimestamps: boolean;
  following: boolean;
  logBuffer: LogLine[];

  // yaml tab
  yamlEditing: boolean;
  yamlDraft: string;

  // ---------- actions ----------
  // navigation
  setNav: (kind: ResourceKind) => void;
  setNamespace: (ns: string) => void;
  setTableFilter: (q: string) => void;
  toggleMenu: (menu: Exclude<OpenMenu, null>) => void;
  closeMenus: () => void;

  // connection/data setters (called by provider event handlers)
  setConnection: (c: Partial<ConnectionState>) => void;
  setContexts: (contexts: ContextInfo[]) => void;
  setClusterStatus: (s: ClusterStatus) => void;
  setWatchCount: (n: number) => void;
  setRows: (kind: ResourceKind, rows: Row[]) => void;
  setPodMetrics: (m: PodMetricsMap) => void;
  setNodeMetrics: (m: NodeMetricsMap) => void;
  resetData: () => void;

  // detail panel
  selectPod: (row: Row) => void;
  closeDetail: () => void;
  setActiveTab: (tab: DetailTab) => void;

  // logs
  setLogSearch: (q: string) => void;
  cycleContainer: () => void;
  toggleTimestamps: () => void;
  toggleFollow: () => void;
  setFollowing: (value: boolean) => void;
  appendLogs: (lines: LogLine[]) => void;
  clearLogs: () => void;

  // yaml
  startYamlEdit: (initial: string) => void;
  cancelYaml: () => void;
  setYamlDraft: (text: string) => void;
}

export const useStore = create<AppState>((set) => ({
  // ---------- initial state ----------
  connection: { phase: "idle", context: null, clusterName: null },
  clusterStatus: null,
  watchCount: 0,
  contexts: [],

  nav: "pods",
  namespace: "all",
  tableFilter: "",
  openMenu: null,

  rows: emptyRows(),
  podMetrics: {},
  nodeMetrics: {},

  selectedPod: null,
  activeTab: "logs",

  logSearch: "",
  containerIndex: 0,
  showTimestamps: true,
  following: true,
  logBuffer: [],

  yamlEditing: false,
  yamlDraft: "",

  // ---------- navigation ----------
  // Switching kind clears the pod selection, any open menu, and the name filter
  // (the filter is scoped to the kind you typed it for).
  setNav: (kind) => set({ nav: kind, selectedPod: null, openMenu: null, tableFilter: "" }),
  // Changing namespace also clears selection (a pod may no longer be visible).
  setNamespace: (ns) => set({ namespace: ns, openMenu: null, selectedPod: null }),
  setTableFilter: (q) => set({ tableFilter: q }),
  // Toggle a menu; opening one closes the other (only one open at a time).
  toggleMenu: (menu) => set((s) => ({ openMenu: s.openMenu === menu ? null : menu })),
  closeMenus: () => set({ openMenu: null }),

  // ---------- connection/data setters ----------
  setConnection: (c) => set((s) => ({ connection: { ...s.connection, ...c } })),
  setContexts: (contexts) => set({ contexts }),
  setClusterStatus: (status) => set({ clusterStatus: status }),
  setWatchCount: (n) => set({ watchCount: n }),
  setRows: (kind, rows) => set((s) => ({ rows: { ...s.rows, [kind]: rows } })),
  setPodMetrics: (m) => set({ podMetrics: m }),
  setNodeMetrics: (m) => set({ nodeMetrics: m }),
  // Wipe all live data on disconnect/context-switch (Story 6.1).
  resetData: () =>
    set({
      rows: emptyRows(),
      podMetrics: {},
      nodeMetrics: {},
      selectedPod: null,
      logBuffer: [],
      clusterStatus: null,
      openMenu: null,
    }),

  // ---------- detail panel ----------
  // Selecting a pod opens the panel on the Logs tab and resets log/yaml view state.
  // (The detail component re-seeds the log stream in response to the selection.)
  selectPod: (row) =>
    set({
      selectedPod: row,
      activeTab: "logs",
      yamlEditing: false,
      logBuffer: [],
      logSearch: "",
      containerIndex: 0,
      following: true,
    }),
  closeDetail: () => set({ selectedPod: null }),
  // Switching tabs cancels any in-progress YAML edit (design behavior).
  setActiveTab: (tab) => set({ activeTab: tab, yamlEditing: false }),

  // ---------- logs ----------
  setLogSearch: (q) => set({ logSearch: q }),
  cycleContainer: () =>
    // Advance the container index and clear the buffer (a new container = new stream).
    set((s) => ({ containerIndex: s.containerIndex + 1, logBuffer: [] })),
  toggleTimestamps: () => set((s) => ({ showTimestamps: !s.showTimestamps })),
  toggleFollow: () => set((s) => ({ following: !s.following })),
  setFollowing: (value) => set({ following: value }),
  // Append new lines, capping the buffer at LOG_BUFFER_CAP (drop oldest).
  appendLogs: (lines) =>
    set((s) => {
      const next = s.logBuffer.concat(lines);
      return { logBuffer: next.length > LOG_BUFFER_CAP ? next.slice(-LOG_BUFFER_CAP) : next };
    }),
  clearLogs: () => set({ logBuffer: [] }),

  // ---------- yaml ----------
  startYamlEdit: (initial) => set({ yamlEditing: true, yamlDraft: initial }),
  cancelYaml: () => set({ yamlEditing: false }),
  setYamlDraft: (text) => set({ yamlDraft: text }),
}));
