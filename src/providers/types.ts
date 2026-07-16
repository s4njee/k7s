/**
 * Shared data contract between the UI and whatever is feeding it data.
 *
 * There are two implementations of {@link DataProvider}:
 *   - TauriProvider  — invokes Rust commands / listens to Tauri events (real cluster)
 *   - MockProvider   — replays the design prototype's data (demo mode, plain browser)
 *
 * Components depend only on this interface, never on either implementation, so the
 * whole UI can run against mock data for pixel-fidelity work without a cluster.
 */

/** The twelve Kubernetes resource kinds the app navigates. */
export type ResourceKind =
  | "pods"
  | "deployments"
  | "statefulsets"
  | "daemonsets"
  | "jobs"
  | "cronjobs"
  | "services"
  | "ingresses"
  | "configmaps"
  | "secrets"
  | "nodes"
  | "namespaces";

/**
 * The one coloring channel exposed by providers. The backend decides semantics
 * (e.g. CrashLoopBackOff → "err"); the table maps tone → a token color. This keeps
 * status semantics in a single place rather than scattered through the UI.
 *
 * Color mapping (see components/table): primary → --text-primary (names),
 * secondary → --text-secondary (metrics/data), muted → --text-muted
 * (namespace/age), ok/warn/err → the semantic status colors.
 */
export type Tone = "primary" | "secondary" | "muted" | "ok" | "warn" | "err";

/** A single table cell. */
export interface Cell {
  /** Display text. When `format === "age"`, this is an RFC3339 timestamp instead. */
  text: string;
  /** Color bucket (see {@link Tone}). */
  tone: Tone;
  /** If true, render a leading "● " status dot in the tone color. */
  dot?: boolean;
  /**
   * When "age", the UI formats `text` (an ISO timestamp) into a k8s-style age
   * ("4d2h") and re-renders it on a periodic tick instead of showing it literally.
   */
  format?: "age";
  /**
   * Optional numeric sort key for columns whose display text can't be compared
   * directly (CPU/MEM, where "3.2Gi" and "486Mi" don't order lexically). Most
   * columns are sorted by an auto-detected heuristic (see lib/sort.ts); this
   * overrides it when set.
   */
  sort?: number;
}

/** Extra fields carried only by pod rows, used to drive the detail panel. */
export interface PodMeta {
  node: string;
  containers: string[];
  status: string;
  ready: string;
  restarts: number;
  /** RFC3339 creation timestamp, formatted into an age in the detail header. */
  creationTs: string;
  /** Tone for the status word / header dot. */
  statusTone: Tone;
}

/** One row in a resource table. */
export interface Row {
  /** Stable identity for React keys and selection (k8s uid, or a synthetic id). */
  uid: string;
  name: string;
  /** Undefined for cluster-scoped kinds (Nodes, Namespaces). */
  namespace?: string;
  /** Cells in the same order as the kind's columns (see lib/kinds.ts). */
  cells: Cell[];
  /** Present only for pods. */
  pod?: PodMeta;
}

/** A Kubernetes Event as shown in the detail panel's Events tab. */
export interface EventItem {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  count: number;
  /** Pre-formatted age string (e.g. "2m"). */
  age: string;
}

/** Cluster-wide status shown in the status bar and cluster switcher. */
export interface ClusterStatus {
  connected: boolean;
  /** Server git version, e.g. "v1.31". */
  version: string;
  apiLatencyMs: number;
  nodesReady: number;
  nodesTotal: number;
  /** null when metrics-server is unavailable — UI renders "—". */
  cpuPercent: number | null;
  memPercent: number | null;
}

/** A kubeconfig context entry for the cluster switcher. */
export interface ContextInfo {
  name: string;
  /** The cluster this context points at (shown as the right-hand env tag). */
  cluster: string;
  /** True for the kubeconfig's current-context. */
  current: boolean;
}

/** Result of a successful {@link DataProvider.connect}. */
export interface ClusterInfo {
  context: string;
  clusterName: string;
  server: string;
  version: string;
}

/** A single parsed log line. */
export interface LogLine {
  /** "HH:MM:SS.mmm", or "" when timestamps are unavailable. */
  ts: string;
  /** Normalized level; "" when no level could be detected. */
  level: "" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  msg: string;
  /** Source container — set only when streaming all containers (B7). */
  container?: string;
}

/** Per-pod resource usage, keyed by "namespace/name". */
export interface PodMetrics {
  cpuMillis: number;
  memBytes: number;
}
export type PodMetricsMap = Record<string, PodMetrics>;

/** Per-node usage percentages, keyed by node name. */
export interface NodeMetrics {
  cpuPercent: number;
  memPercent: number;
}
export type NodeMetricsMap = Record<string, NodeMetrics>;

/** Persisted UI preferences (B11) — where the user left off. */
export interface Prefs {
  context?: string | null;
  nav?: ResourceKind | null;
  namespace?: string | null;
  showTimestamps?: boolean | null;
}

/** Identifies a specific object for YAML/events/log commands. */
export interface ResourceRef {
  kind: ResourceKind;
  namespace?: string;
  name: string;
}

/** Options for starting a log stream. */
export interface LogOptions {
  /** Resume streaming only lines newer than this RFC3339 time (used on un-pause). */
  sinceTime?: string;
  /** Number of historical lines to seed with on first open. */
  tail?: number;
}

/** Handle for a running log stream; call {@link stop} to cancel it. */
export interface LogHandle {
  stop(): void;
}

/** Handle for an interactive shell session (B4). */
export interface ShellHandle {
  /** Send keystrokes to the container. */
  input(data: string): void;
  /** Notify the container of a terminal resize. */
  resize(cols: number, rows: number): void;
  /** End the session. */
  stop(): void;
}

/** An active port-forward (B6). */
export interface ForwardInfo {
  id: string;
  namespace: string;
  pod: string;
  remotePort: number;
  localPort: number;
}

/** Unsubscribe function returned by the `on*` event subscriptions. */
export type Unsub = () => void;

/**
 * The full provider contract. See file header for the two implementations.
 */
export interface DataProvider {
  // ---- one-shot commands ----
  listContexts(): Promise<ContextInfo[]>;
  connect(context: string): Promise<ClusterInfo>;
  /**
   * Import contexts from a kubeconfig file (via a native file picker). Returns the
   * merged context list to replace the switcher's, or null if the user cancelled.
   */
  importKubeconfig(): Promise<ContextInfo[] | null>;
  getYaml(ref: ResourceRef): Promise<string>;
  /** Rejects with the API error message (shown inline) on failure. */
  applyYaml(ref: ResourceRef, text: string): Promise<void>;
  getEvents(ref: ResourceRef): Promise<EventItem[]>;

  // ---- mutations (B3); all reject with the API error message on failure ----
  /** Delete a resource of any kind. */
  deleteResource(ref: ResourceRef): Promise<void>;
  /** Scale a Deployment/StatefulSet to `replicas`. */
  scaleResource(ref: ResourceRef, replicas: number): Promise<void>;
  /** Cordon or uncordon a node. */
  setCordon(node: string, unschedulable: boolean): Promise<void>;

  // ---- persisted preferences (B11) ----
  /** Load persisted UI preferences, or null if none / not supported (demo). */
  loadPrefs(): Promise<Prefs | null>;
  /** Persist UI preferences (no-op in demo mode). */
  savePrefs(prefs: Prefs): Promise<void>;

  // ---- push subscriptions (return an unsubscribe fn) ----
  onResourceUpdate(cb: (kind: ResourceKind, rows: Row[]) => void): Unsub;
  onPodMetrics(cb: (metrics: PodMetricsMap) => void): Unsub;
  onNodeMetrics(cb: (metrics: NodeMetricsMap) => void): Unsub;
  onClusterStatus(cb: (status: ClusterStatus) => void): Unsub;
  onWatchStatus(cb: (activeStreams: number) => void): Unsub;

  // ---- log streaming ----
  startLogs(
    ref: ResourceRef,
    container: string,
    opts: LogOptions,
    onLines: (lines: LogLine[]) => void,
    onClosed: (reason: string) => void,
  ): Promise<LogHandle>;

  // ---- shell / exec (B4) ----
  startShell(
    ref: ResourceRef,
    container: string,
    onOutput: (data: string) => void,
    onClosed: (reason: string) => void,
  ): Promise<ShellHandle>;

  // ---- port-forwarding (B6) ----
  startPortForward(ref: ResourceRef, remotePort: number): Promise<ForwardInfo>;
  stopPortForward(id: string): Promise<void>;
  listPortForwards(): Promise<ForwardInfo[]>;
}
