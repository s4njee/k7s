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
 * kind ids aren't known at build time.
 */
export type RowMap = Record<string, Row[]>;

export interface NavigationState {
  nav: KindId;
  namespace: string;
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
  connection: ConnectionState;
  clusterStatus: ClusterStatus | null;
  watchCount: number;
  contexts: ContextInfo[];
  importedFiles: string[];
  bookmarksByContext: Record<string, Bookmark[]>;
}

export interface ConnectionActions {
  setConnection: (c: Partial<ConnectionState>) => void;
  setContexts: (contexts: ContextInfo[]) => void;
  setImportedFiles: (paths: string[]) => void;
  addImportedFile: (path: string) => void;
  addBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmark: Bookmark) => void;
  toggleBookmark: (bookmark: Bookmark) => void;
  setClusterStatus: (s: ClusterStatus) => void;
  setWatchCount: (n: number) => void;
}

export interface DataSliceState {
  rows: RowMap;
  customKinds: CustomKind[];
  settings: Settings;
  selection: SelectionState;
  systemDark: boolean;
  settingsOpen: boolean;
  createOpen: boolean;
  paletteOpen: boolean;
  podMetrics: PodMetricsMap;
  nodeMetrics: NodeMetricsMap;
  portForwards: ForwardInfo[];
  drains: Record<string, DrainProgress>;
  nodeSamples: Record<string, NodeSample[]>;
  nodeStatsErrors: Record<string, string>;
  podSamples: Record<string, PodSample[]>;
}

export interface DataActions {
  setRows: (kind: KindId, rows: Row[]) => void;
  setCustomKinds: (kinds: CustomKind[]) => void;
  setPodMetrics: (m: PodMetricsMap) => void;
  setNodeMetrics: (m: NodeMetricsMap) => void;
  setPortForwards: (list: ForwardInfo[]) => void;
  setDrain: (progress: DrainProgress) => void;
  seedNodeSamples: (node: string, history: NodeSample[]) => void;
  addNodeSample: (node: string, sample: NodeSample) => void;
  setNodeStatsError: (node: string, message: string) => void;
  addPodSample: (key: string, sample: PodSample) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setSystemDark: (dark: boolean) => void;
  setSelection: (selection: SelectionState) => void;
  clearSelection: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCreateOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  resetData: () => void;
}

export interface DetailSliceState {
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

export type AppState = NavigationState &
  NavigationActions &
  ConnectionSliceState &
  ConnectionActions &
  DataSliceState &
  DataActions &
  DetailSliceState &
  DetailActions &
  UpdateState &
  UpdateActions;
