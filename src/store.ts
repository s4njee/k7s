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
  CustomKind,
  ForwardInfo,
  KindId,
  LogLine,
  NodeMetricsMap,
  PodMetricsMap,
  Row,
} from "./providers/types";
import { KIND_ORDER } from "./lib/kinds";

/** Ring-buffer cap for the log view (design default). */
export const LOG_BUFFER_CAP = 200;

/** Detail-panel tab identifiers. */
export type DetailTab = "logs" | "properties" | "shell" | "yaml" | "events";

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

/**
 * Rows keyed by kind id. Not a `Record<ResourceKind, …>`: custom (CRD-backed)
 * kind ids aren't known at build time, and their entries only appear once the
 * kind is watched — so readers must tolerate a missing key (see {@link rowsFor}).
 */
export type RowMap = Record<string, Row[]>;

/** Empty row map: every built-in kind present with an empty array. */
function emptyRows(): RowMap {
  return Object.fromEntries(KIND_ORDER.map((k) => [k, [] as Row[]]));
}

/** Rows for a kind, or an empty array for a custom kind not yet watched (B15). */
export function rowsFor(rows: RowMap, kind: KindId): Row[] {
  return rows[kind] ?? EMPTY_ROWS;
}

/** Shared empty array so `rowsFor` returns a stable reference (avoids re-renders). */
const EMPTY_ROWS: Row[] = [];

export interface AppState {
  // ---------- connection & cluster ----------
  connection: ConnectionState;
  clusterStatus: ClusterStatus | null;
  watchCount: number;
  /** Available kubeconfig contexts (cluster switcher entries). */
  contexts: ContextInfo[];

  // ---------- navigation & filtering ----------
  /** Active resource kind (drives the table + breadcrumb); a custom id for CRDs. */
  nav: KindId;
  /** Namespace filter; "all" shows everything. */
  namespace: string;
  /** Free-text name filter for the current table (cleared on nav change). */
  tableFilter: string;
  /** Column index the table is sorted by, or null for server order. */
  sortCol: number | null;
  /** Sort direction when `sortCol` is set. */
  sortDir: "asc" | "desc";
  /** Which dropdown is open (cluster switcher or ns menu). */
  openMenu: OpenMenu;

  // ---------- live data ----------
  /** Rows per kind. Built-ins always present; custom kinds appear once watched. */
  rows: RowMap;
  /** CRD-backed kinds discovered on connect (B15); empty when disconnected. */
  customKinds: CustomKind[];
  podMetrics: PodMetricsMap;
  nodeMetrics: NodeMetricsMap;
  /** Active port-forwards (B6). */
  portForwards: ForwardInfo[];

  // ---------- detail panel ----------
  /** Selected row (null → panel closed). Pods also get a Logs tab. */
  selectedRow: Row | null;
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
  setNav: (kind: KindId) => void;
  setNamespace: (ns: string) => void;
  setTableFilter: (q: string) => void;
  /** Sort by a column: same column toggles direction, a new column starts ascending. */
  toggleSort: (col: number) => void;
  toggleMenu: (menu: Exclude<OpenMenu, null>) => void;
  closeMenus: () => void;

  // connection/data setters (called by provider event handlers)
  setConnection: (c: Partial<ConnectionState>) => void;
  setContexts: (contexts: ContextInfo[]) => void;
  setClusterStatus: (s: ClusterStatus) => void;
  setWatchCount: (n: number) => void;
  setRows: (kind: KindId, rows: Row[]) => void;
  setCustomKinds: (kinds: CustomKind[]) => void;
  setPodMetrics: (m: PodMetricsMap) => void;
  setNodeMetrics: (m: NodeMetricsMap) => void;
  setPortForwards: (list: ForwardInfo[]) => void;
  resetData: () => void;

  // detail panel
  selectRow: (row: Row) => void;
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
  sortCol: null,
  sortDir: "asc",
  openMenu: null,

  rows: emptyRows(),
  customKinds: [],
  podMetrics: {},
  nodeMetrics: {},
  portForwards: [],

  selectedRow: null,
  activeTab: "logs",

  logSearch: "",
  containerIndex: 0,
  showTimestamps: true,
  following: true,
  logBuffer: [],

  yamlEditing: false,
  yamlDraft: "",

  // ---------- navigation ----------
  // Switching kind clears the pod selection, any open menu, the name filter, and
  // the sort (all are scoped to the kind you were viewing).
  setNav: (kind) =>
    set({
      nav: kind,
      selectedRow: null,
      openMenu: null,
      tableFilter: "",
      sortCol: null,
      sortDir: "asc",
    }),
  // Changing namespace also clears selection (a pod may no longer be visible).
  setNamespace: (ns) => set({ namespace: ns, openMenu: null, selectedRow: null }),
  setTableFilter: (q) => set({ tableFilter: q }),
  toggleSort: (col) =>
    set((s) =>
      s.sortCol === col
        ? { sortDir: s.sortDir === "asc" ? "desc" : "asc" }
        : { sortCol: col, sortDir: "asc" },
    ),
  // Toggle a menu; opening one closes the other (only one open at a time).
  toggleMenu: (menu) => set((s) => ({ openMenu: s.openMenu === menu ? null : menu })),
  closeMenus: () => set({ openMenu: null }),

  // ---------- connection/data setters ----------
  setConnection: (c) => set((s) => ({ connection: { ...s.connection, ...c } })),
  setContexts: (contexts) => set({ contexts }),
  setClusterStatus: (status) => set({ clusterStatus: status }),
  setWatchCount: (n) => set({ watchCount: n }),
  setRows: (kind, rows) => set((s) => ({ rows: { ...s.rows, [kind]: rows } })),
  setCustomKinds: (kinds) => set({ customKinds: kinds }),
  setPodMetrics: (m) => set({ podMetrics: m }),
  setNodeMetrics: (m) => set({ nodeMetrics: m }),
  setPortForwards: (list) => set({ portForwards: list }),
  // Wipe all live data on disconnect/context-switch (Story 6.1). The backend also
  // aborts every forward/shell on reset, so we clear the local list here too.
  resetData: () =>
    set({
      rows: emptyRows(),
      // The discovered CRDs belong to the old cluster; connect re-discovers them.
      // `nav` is deliberately left alone: on a reconnect to the same cluster the
      // kind comes straight back, and a nav pointing at a kind this cluster lacks
      // renders an empty table rather than yanking the user elsewhere.
      customKinds: [],
      podMetrics: {},
      nodeMetrics: {},
      portForwards: [],
      selectedRow: null,
      logBuffer: [],
      clusterStatus: null,
      openMenu: null,
    }),

  // ---------- detail panel ----------
  // Selecting a row opens the panel and resets log/yaml view state. Pods open on
  // the Logs tab; other kinds have no Logs tab, so they open on YAML.
  // (The logs component re-seeds the stream in response to a pod selection.)
  selectRow: (row) =>
    set({
      selectedRow: row,
      activeTab: row.pod ? "logs" : "yaml",
      yamlEditing: false,
      logBuffer: [],
      logSearch: "",
      containerIndex: 0,
      following: true,
    }),
  closeDetail: () => set({ selectedRow: null }),
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
