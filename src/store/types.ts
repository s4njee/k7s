/**
 * Store type definitions.
 */

import type {
  ClusterStatus,
  ContextInfo,
  CustomKind,
  DrainProgress,
  ForwardInfo,
  KindId,
  LogLine,
  NavTarget,
  NodeMetricsMap,
  NodeSample,
  PodMetricsMap,
  PodSample,
  Row,
} from "../providers/types";
import type { Bookmark } from "../lib/bookmarks";
import type { Settings } from "../lib/settings";
import type { SelectionState } from "../lib/selection";
import type { SinceOption } from "../lib/logview";

/** Detail-panel tab identifiers. */
export type DetailTab =
  | "logs"
  | "properties"
  | "metrics"
  | "shell"
  | "yaml"
  | "events"
  | "diff"
  | "topology";

/** Which dropdown menu (if any) is currently open — only one at a time. */
export type OpenMenu = "cluster" | "ns" | null;

/** Connection lifecycle for a cluster/context. */
export interface ConnectionState {
  phase: "idle" | "connecting" | "connected" | "error";
  /** kubeconfig context name. */
  context: string | null;
  /** Cluster display name (from connect result). */
  clusterName: string | null;
  /** Error message when phase === "error". */
  error?: string;
}

/**
 * Rows keyed by kind id. Not a `Record<ResourceKind, …>`: custom (CRD-backed)
 * kind ids aren't known at build time.
 */
export type RowMap = Record<string, Row[]>;

/**
 * The store holds per-cluster data (B77). Components read the *active* slice —
 * `rows`, `connection`, `clusterStatus`, `nav`, … — which always reflects
 * `activeCid`; the `*ByCid` maps retain every connected cluster's data so a
 * switch back is instant and background clusters keep their problems/state.
 */
export type Cid = string;

export interface NavigationState {
  nav: KindId;
  /** Per-cluster retained nav, so switching back restores the view. */
  navByCid: Record<Cid, KindId>;
  namespace: string;
  namespaceByCid: Record<Cid, string>;
  tableFilter: string;
  sortCol: number | null;
  sortDir: "asc" | "desc";
  openMenu: OpenMenu;
}

export interface NavigationActions {
  setNav: (kind: KindId) => void;
  setNamespace: (ns: string) => void;
  setTableFilter: (q: string) => void;
  toggleSort: (col: number) => void;
  toggleMenu: (menu: Exclude<OpenMenu, null>) => void;
  closeMenus: () => void;
  jumpTo: (kind: KindId, row?: Row) => void;
  navigateTo: (target: NavTarget) => void;
  viewPods: (namespace: string | undefined, selector: string) => void;
}

export interface ConnectionSliceState {
  /** The cluster the UI is currently showing (B77). */
  activeCid: Cid | null;
  /** Every connected cluster's lifecycle, keyed by cid. */
  connections: Record<Cid, ConnectionState>;
  /** Active slice of [`ConnectionState`] — mirrors `connections[activeCid]`. */
  connection: ConnectionState;
  /** Per-cluster cluster-status (retained for the rail / switching back). */
  clusterStatusByCid: Record<Cid, ClusterStatus | null>;
  /** Active slice of cluster-status. */
  clusterStatus: ClusterStatus | null;
  watchCountByCid: Record<Cid, number>;
  watchCount: number;
  contexts: ContextInfo[];
  importedFiles: string[];
  bookmarksByContext: Record<string, Bookmark[]>;
  /** Per-cluster rail colour (B77), user-set; defaults to a palette pick. */
  clusterColors: Record<string, string>;
  /** Per-cluster default namespace (B77), layered over the global setting. */
  clusterNamespaces: Record<string, string>;
}

export interface ConnectionActions {
  setActiveCid: (cid: Cid) => void;
  setConnection: (cid: Cid, c: Partial<ConnectionState>) => void;
  setContexts: (contexts: ContextInfo[]) => void;
  setImportedFiles: (paths: string[]) => void;
  addImportedFile: (path: string) => void;
  addBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmark: Bookmark) => void;
  toggleBookmark: (bookmark: Bookmark) => void;
  setClusterColor: (cid: string, color: string) => void;
  setClusterNamespace: (cid: string, ns: string) => void;
  setClusterStatus: (cid: Cid, s: ClusterStatus) => void;
  setWatchCount: (cid: Cid, n: number) => void;
}

export interface DataSliceState {
  /** Active rows (see [`NavigationState`] for the per-cid pattern). */
  rows: RowMap;
  rowsByCid: Record<Cid, RowMap>;
  customKinds: CustomKind[];
  customKindsByCid: Record<Cid, CustomKind[]>;
  settings: Settings;
  selection: SelectionState;
  selectionByCid: Record<Cid, SelectionState>;
  systemDark: boolean;
  settingsOpen: boolean;
  createOpen: boolean;
  paletteOpen: boolean;
  /** Problems view scope (B77): the active cluster, or aggregated across all. */
  problemsScope: "active" | "all";
  podMetrics: PodMetricsMap;
  podMetricsByCid: Record<Cid, PodMetricsMap>;
  nodeMetrics: NodeMetricsMap;
  nodeMetricsByCid: Record<Cid, NodeMetricsMap>;
  portForwards: ForwardInfo[];
  portForwardsByCid: Record<Cid, ForwardInfo[]>;
  drains: Record<string, DrainProgress>;
  drainsByCid: Record<Cid, Record<string, DrainProgress>>;
  nodeSamples: Record<string, NodeSample[]>;
  nodeSamplesByCid: Record<Cid, Record<string, NodeSample[]>>;
  nodeStatsErrors: Record<string, string>;
  nodeStatsErrorsByCid: Record<Cid, Record<string, string>>;
  podSamples: Record<string, PodSample[]>;
  podSamplesByCid: Record<Cid, Record<string, PodSample[]>>;
}

export interface DataActions {
  setRows: (cid: Cid, kind: KindId, rows: Row[]) => void;
  setRowsDelta: (cid: Cid, kind: KindId, upserts: Row[], deletes: string[]) => void;
  setCustomKinds: (cid: Cid, kinds: CustomKind[]) => void;
  setPodMetrics: (cid: Cid, m: PodMetricsMap) => void;
  setNodeMetrics: (cid: Cid, m: NodeMetricsMap) => void;
  setPortForwards: (cid: Cid, list: ForwardInfo[]) => void;
  setDrain: (cid: Cid, progress: DrainProgress) => void;
  seedNodeSamples: (cid: Cid, node: string, history: NodeSample[]) => void;
  addNodeSample: (cid: Cid, node: string, sample: NodeSample) => void;
  setNodeStatsError: (cid: Cid, node: string, message: string) => void;
  addPodSample: (cid: Cid, key: string, sample: PodSample) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setSystemDark: (dark: boolean) => void;
  setSelection: (selection: SelectionState) => void;
  clearSelection: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCreateOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setProblemsScope: (scope: "active" | "all") => void;
  /** Wipe one cluster's retained data (failed connect / rail removal). */
  resetData: (cid: Cid) => void;
}

/** The detail-panel fields for one cluster (the retained value of [`DetailSliceState`]). */
export type DetailState = {
  selectedRow: Row | null;
  activeTab: DetailTab;
  logSearch: string;
  containerIndex: number;
  showTimestamps: boolean;
  following: boolean;
  logBuffer: LogLine[];
  logPrevious: boolean;
  logSince: SinceOption;
  yamlEditing: boolean;
  yamlDraft: string;
};

export interface DetailSliceState extends DetailState {
  /** Per-cluster retained detail, swapped on `setActiveCid`. */
  detailByCid: Record<Cid, DetailState>;
}

export interface DetailActions {
  selectRow: (row: Row) => void;
  closeDetail: () => void;
  setActiveTab: (tab: DetailTab) => void;
  setLogSearch: (q: string) => void;
  cycleContainer: () => void;
  toggleTimestamps: () => void;
  toggleFollow: () => void;
  setFollowing: (value: boolean) => void;
  setLogPrevious: (value: boolean) => void;
  setLogSince: (value: SinceOption) => void;
  appendLogs: (lines: LogLine[]) => void;
  clearLogs: () => void;
  startYamlEdit: (initial: string) => void;
  cancelYaml: () => void;
  setYamlDraft: (text: string) => void;
}

/** Automatic-update lifecycle (B72): passive, never nags. */
export type UpdateStatus = "idle" | "checking" | "none" | "available" | "downloading" | "installed";

export interface UpdateState {
  status: UpdateStatus;
  /** Version of the running app (from Tauri; undefined in demo mode). */
  currentVersion?: string;
  /** Version an update offers, when one is available. */
  version?: string;
  /** Release notes from the manifest (kept for the update notice; rendered
   *  as plain text only — manifest content is remote, never HTML). */
  notes?: string;
}

export interface UpdateActions {
  setUpdate: (patch: Partial<UpdateState>) => void;
}

/** One open local kubectl terminal (B82). Terminals are global, not per-active
 *  cluster: a terminal opened on cluster A keeps running while viewing cluster B,
 *  and the tab carries its cluster's badge. */
export interface TerminalInfo {
  /** Frontend tab identity (also the xterm's key). */
  id: string;
  /** The cluster the terminal's KUBECONFIG names. */
  cid: Cid;
}

export interface TerminalSliceState {
  /** Open terminals, in open order. */
  terminals: TerminalInfo[];
  /** Which terminal's xterm is visible (the rest stay mounted, hidden). */
  activeTerminalId: string | null;
}

export interface TerminalActions {
  /** Open a terminal for a connected cluster; no-op when none is connected. */
  openTerminal: (cid: Cid) => void;
  /** Close a terminal's tab (the component stops its session first). */
  closeTerminal: (id: string) => void;
  /** Focus a terminal's xterm. */
  setActiveTerminal: (id: string) => void;
}

export type AppState = NavigationState &
  NavigationActions &
  ConnectionSliceState &
  ConnectionActions &
  DataSliceState &
  DataActions &
  DetailSliceState &
  DetailActions &
  TerminalSliceState &
  TerminalActions &
  UpdateState &
  UpdateActions;
