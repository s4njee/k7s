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

/**
 * The Kubernetes resource kinds the app navigates. "events" is a read-only
 * cluster-wide feed rather than a managed resource (B14), but it rides the same
 * row/table plumbing as the rest.
 */
export type ResourceKind =
  | "pods"
  | "deployments"
  | "replicasets"
  | "statefulsets"
  | "daemonsets"
  | "jobs"
  | "cronjobs"
  | "services"
  | "ingresses"
  | "ingressclasses"
  | "configmaps"
  | "secrets"
  | "serviceaccounts"
  | "roles"
  | "clusterroles"
  | "rolebindings"
  | "clusterrolebindings"
  | "persistentvolumeclaims"
  | "persistentvolumes"
  | "storageclasses"
  | "nodes"
  | "namespaces"
  | "events"
  | "helm"
  /**
   * The problems pseudo-kind (B32): a frontend-only aggregation over the other
   * kinds' rows. Not a real Kubernetes resource — it has no watcher and no YAML.
   */
  | "problems"
  /**
   * The overview pseudo-kind (B79): a frontend-only dashboard — no watcher,
   * no YAML, just a landing page after connect.
   */
  | "overview"
  // B80 kind sweep: autoscaling, disruption budgets, network policy,
  // quota/limits, and the admission webhooks.
  | "horizontalpodautoscalers"
  | "poddisruptionbudgets"
  | "networkpolicies"
  | "resourcequotas"
  | "limitranges"
  | "mutatingwebhookconfigurations"
  | "validatingwebhookconfigurations";

/**
 * One `additionalPrinterColumn` a CRD declares for its kind (B30): a column the
 * kind's table shows between NAMESPACE and AGE, whose value the backend
 * evaluates from each object's `jsonPath`.
 */
export interface PrinterColumn {
  /** Column header, e.g. "Sync Status". */
  name: string;
  /** kubectl column type: "string", "integer", "date", "boolean", … */
  type: string;
  /** JSONPath into the object, e.g. ".status.sync.status". */
  jsonPath: string;
}

/**
 * A CRD-backed kind discovered on connect (B15).
 *
 * These aren't known at build time, so they can't be part of {@link ResourceKind}.
 */
export interface CustomKind {
  /** Stable id, always "group/plural" (e.g. "argoproj.io/applications"). */
  id: string;
  group: string;
  /** The version being watched (the CRD's storage version). */
  version: string;
  /** Kind name, e.g. "Application" — the nav label. */
  kind: string;
  plural: string;
  /** False for cluster-scoped CRDs, which ignore the namespace filter. */
  namespaced: boolean;
  /**
   * Printer columns declared by the CRD's storage version (B30), in declared
   * order. Empty (or absent) when the CRD declares none — the kind then keeps
   * the generic NAME, NAMESPACE?, AGE columns.
   */
  printerColumns?: PrinterColumn[];
}

/**
 * Any kind the table can show: a built-in {@link ResourceKind} or a custom kind's
 * id. The `(string & {})` keeps editor autocomplete for the built-in literals
 * while still admitting the dynamic ids.
 *
 * A custom id always contains a slash; a built-in id never does. That's the test
 * used wherever the two need distinguishing (`isCustomKind`).
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type KindId = ResourceKind | (string & {});

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
  /**
   * When set, this cell names another object and renders as a click-through link
   * in the Properties tables (B40). List tables ignore it — clicking the row is
   * already the navigation there.
   */
  nav?: NavTarget;
}

/**
 * A pod's total CPU/memory requests and limits, summed across its regular
 * containers (init excluded) to match the usage the metrics feed reports. Units
 * are millicores (CPU) and bytes (memory). `null` means unset — and for a limit,
 * that a container is uncapped, so the Metrics tab draws no ceiling line.
 */
export interface PodResources {
  cpuRequestMillis: number | null;
  cpuLimitMillis: number | null;
  memRequestBytes: number | null;
  memLimitBytes: number | null;
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
  /** Aggregate requests/limits, for the Metrics tab's overlay lines. */
  resources: PodResources;
}

/** The object an Event is about, for click-through navigation (B33). */
export interface InvolvedRef {
  /** Kubernetes Kind, e.g. "Pod", "Deployment", "Application". */
  kind: string;
  name: string;
  namespace?: string;
  /** apiVersion, e.g. "argoproj.io/v1alpha1"; its group disambiguates CRDs. */
  apiVersion?: string;
}

/**
 * What a `resource-update` carries for one kind (B78): either a full row
 * snapshot (watcher start / resync / the Events kind / re-switch) or a delta of
 * upserts + deletes keyed by uid. The store applies the latter without a full
 * rebuild.
 */
export type RowUpdate = { rows: Row[] } | { upserts: Row[]; deletes: string[] };

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
  /** Labels, for label-selector filtering (B33). Present on pods. */
  labels?: Record<string, string>;
  /** A workload's pod selector (matchLabels), for the "view pods" jump (B33). */
  selector?: Record<string, string>;
  /** Present only on Event rows: the object the event is about (B33). */
  involved?: InvolvedRef;
  /** Job status beyond the cells, for the problems view (B32). */
  job?: { failed: boolean };
  /** CronJob state beyond the cells: whether the schedule is suspended (B47). */
  cron?: { suspended: boolean };
}

/** A Kubernetes Event as shown in the detail panel's Events tab. */
export interface EventItem {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  count: number;
  /** Pre-formatted age string (e.g. "2m"). */
  age: string;
  /** RFC3339 timestamp of the event's first/last occurrence. */
  timestamp?: string;
  /** The object this event is about. */
  involved?: EventInvolved;
}

/** The object an Event refers to (its `involvedObject`), for click-through navigation (B33). `kind` + the group from
 * `api_version` resolve to a nav id — including CRDs, where the kind alone can
 * be ambiguous across groups. */
export interface EventInvolved {
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
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

/** Result of a successful kubeconfig import. */
export interface ImportResult {
  /** The merged switcher list: default kubeconfig contexts + all imported ones. */
  contexts: ContextInfo[];
  /** The file that was imported, persisted so it survives a relaunch (B17). */
  path: string;
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
  /** Source pod — set only on a workload log bundle (B31). */
  pod?: string;
}

/** Per-pod resource usage, keyed by "namespace/name". */
export interface PodMetrics {
  cpuMillis: number;
  memBytes: number;
}
export type PodMetricsMap = Record<string, PodMetrics>;

/**
 * One point in a pod's live usage series, accumulated while its Metrics tab is
 * open. Unlike a node's NodeSample (scraped from node-exporter), these come from
 * the same `metrics.k8s.io` feed that drives the pod list — summed across the
 * pod's containers — so a single point is already a real reading, not a rate that
 * needs two scrapes to compute.
 */
export interface PodSample {
  /** Epoch milliseconds — the x axis. */
  ts: number;
  cpuMillis: number;
  memBytes: number;
}

/** Per-node usage percentages, keyed by node name. */
export interface NodeMetrics {
  cpuPercent: number;
  memPercent: number;
}
export type NodeMetricsMap = Record<string, NodeMetrics>;

/** A label/annotation entry. */
export interface KeyValue {
  key: string;
  value: string;
}

/**
 * A navigable target: a nav id plus the object's namespace/name (B33). Carried by
 * a properties {@link Field} and by any {@link Cell} that names another object.
 */
export interface NavTarget {
  /** Nav id — a built-in plural ("deployments") or a CRD "group/plural". */
  kind: KindId;
  namespace?: string;
  name: string;
}

/** One row of a properties field grid: a label, a toned value, and an optional
 * nav target that makes the value a click-through link (B33). */
export interface Field {
  label: string;
  value: Cell;
  nav?: NavTarget;
}

/**
 * What a properties section renders as (B18). Discriminated by `type`, matching
 * the backend's tagged enum.
 */
export type SectionBody =
  | { type: "fields"; fields: Field[] }
  | { type: "table"; columns: string[]; rows: Cell[][] }
  | { type: "chips"; chips: KeyValue[] };

/** One section of the Properties tab. */
export interface Section {
  title: string;
  /** Rendered in place of an empty table ("no taints"). */
  emptyNote?: string;
  body: SectionBody;
}

/**
 * Everything the Properties tab renders, for any kind (B13, B18).
 *
 * The backend decides both the content *and* the shape: sections are a generic
 * grid/table/chips document, so a new kind is a backend gatherer and no frontend
 * change. See src-tauri/src/kube/properties.rs.
 */
/**
 * What a proposed YAML edit would actually do, as the server sees it (B36).
 * `proposed` is the object that *would* be stored — after defaulting and any
 * mutating webhooks — so it can differ from the text that was typed.
 */
export interface YamlDiff {
  current: string;
  proposed: string;
}

export interface Properties {
  sections: Section[];
}

/** One node in the topology graph (B55): a resource in the neighborhood. */
export interface TopologyNode {
  /** Stable id, "{nav}:{namespace}/{name}". */
  id: string;
  /** Kubernetes Kind, e.g. "Deployment" (for the node's label). */
  kind: string;
  namespace: string;
  name: string;
  /** Nav id a click navigates to ("deployments", "pods", …). */
  nav: KindId;
}

/** A directed edge; `from` owns or references `to` (B55). */
export interface TopologyEdge {
  from: string;
  to: string;
  /** "ownership" (solid) or "reference" (dashed). */
  rel: "ownership" | "reference";
}

/** The graph around one resource (B55). */
export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

/** Persisted UI preferences (B11) — where the user left off. */
export interface Prefs {
  context?: string | null;
  /** Last kind viewed; may be a custom kind's id (B15). */
  nav?: KindId | null;
  namespace?: string | null;
  showTimestamps?: boolean | null;
  /** Kubeconfig files imported by the user, re-imported on boot (B17). */
  importedFiles?: string[] | null;
  /** Bookmarks (B56) keyed by cluster context, so each context has its own list. */
  bookmarks?: Record<string, Bookmark[]> | null;
  /** Per-cluster rail colour + default namespace (B77). */
  clusterColors?: Record<string, string> | null;
  clusterNamespaces?: Record<string, string> | null;
  // ---- settings (B23) ----
  // Flat rather than nested so an older prefs.json keeps loading: serde and
  // JSON.parse both just leave absent fields undefined, and sanitizeSettings
  // fills them with defaults.
  logBufferCap?: number | null;
  metricsIntervalSecs?: number | null;
  statusIntervalSecs?: number | null;
  defaultNamespace?: string | null;
  shellCommand?: string | null;
  /** Colour palette: "dark" | "light" | "system" (B52). */
  theme?: string | null;
  /** UI font: "mono" | "sans". */
  uiFont?: string | null;
  /** Accent colour: "blue" | "green" | "purple" | "orange". */
  accent?: string | null;
  /** Disable the pulsing "live" dot and other motion. */
  reduceMotion?: boolean | null;
  /** Native problem notifications (B50). */
  notifications?: boolean | null;
  /** Image for the node debug shell; empty uses the default (B53). */
  nodeShellImage?: string | null;
}

/** Identifies a specific object for YAML/events/log commands. */
export interface ResourceRef {
  /** Built-in kind id, or a custom kind's "group/plural" id (B15). */
  kind: KindId;
  namespace?: string;
  name: string;
}

/** A bookmarked resource (B56) — a resource ref the sidebar keeps quick access to. */
export interface Bookmark {
  kind: KindId;
  namespace?: string;
  name: string;
}

/** Options for starting a log stream. */
export interface LogOptions {
  /** Resume streaming only lines newer than this RFC3339 time (used on un-pause). */
  sinceTime?: string;
  /** Number of historical lines to seed with on first open. */
  tail?: number;
  /**
   * Only lines from the last N seconds (B29). Ignored when `sinceTime` is set —
   * the API rejects both, and the resume anchor is the more precise of the two.
   */
  sinceSeconds?: number;
  /**
   * Read the previous container generation (B29). A snapshot, not a stream: the
   * previous container is dead, so the read ends rather than following.
   */
  previous?: boolean;
}

/** Result of saving a log to disk (B29). */
export interface SavedLog {
  path: string;
  lines: number;
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

/**
 * A node debug shell session (B53) — a {@link ShellHandle} that also names the pod
 * backing it.
 *
 * The pod name is surfaced deliberately: this feature creates a *privileged* pod on
 * the node, and the UI shows exactly which one, so it is never something the app
 * did invisibly. If teardown ever fails, that name is what the user needs.
 */
export interface NodeShellHandle extends ShellHandle {
  readonly namespace: string;
  readonly pod: string;
}

/** An active port-forward (B6). */
export interface ForwardInfo {
  id: string;
  /** The cluster this forward belongs to (B77) — the strip badges it. */
  cid: string;
  namespace: string;
  /** The pod traffic reaches — for a Service forward, the one selected (B16). */
  pod: string;
  /** Set for Service forwards: the service name, which is what the strip shows. */
  service?: string;
  /** Port on the pod (a Service forward's resolved targetPort). */
  remotePort: number;
  /**
   * For Service forwards, the port the user actually asked for — the Service's
   * own port — when it differs from the resolved targetPort (B16). The strip
   * shows this: `remotePort` is a container port the Service doesn't publish.
   */
  servicePort?: number;
  localPort: number;
  /** Last per-connection failure; the forward stays up (B16). */
  error?: string;
}

/** A pod a drain could not evict (B20). */
export interface DrainFailure {
  pod: string;
  message: string;
  /** True when a PodDisruptionBudget held it back (429), not a real error. */
  blockedByPdb: boolean;
}

/** Progress of a node drain (B20). */
export interface DrainProgress {
  node: string;
  evicted: number;
  /** Pods eligible for eviction (excludes DaemonSet/mirror/finished pods). */
  total: number;
  failures: DrainFailure[];
  /** False while working; true once every pod has been attempted. */
  done: boolean;
}

/** One PodDisruptionBudget's contribution to a drain preview (B61/B80). */
export interface PdbPreview {
  name: string;
  namespace: string;
  minAvailable: string;
  maxUnavailable: string;
  currentHealthy: number;
  desiredHealthy: number;
  /** 0 means no pod covered by this budget can be evicted right now. */
  disruptionsAllowed: number;
  /** The node's evictable pods this PDB covers ("prod/yggdrasil-db-0"). */
  pods: string[];
}

/**
 * What draining a node would touch, before any eviction (B61/B80) — shown in
 * the drain confirm dialog so a drain that would stall on a PDB is visible
 * before committing.
 */
export interface DrainPreview {
  node: string;
  /** Evictable pods on the node (DaemonSet/mirror/finished pods excluded). */
  podCount: number;
  /** The PDBs those pods are subject to, with their current disruption math. */
  pdbs: PdbPreview[];
}

/** What an uninstall removed (B81). */
export interface UninstallOutcome {
  objectsDeleted: number;
  secretsDeleted: number;
}

/** One mounted filesystem on a node (B27). */
export interface Filesystem {
  mountpoint: string;
  usedBytes: number;
  sizeBytes: number;
}

/**
 * One node-exporter sample, rates already computed by the backend (B27).
 * The frontend only plots these.
 */
/** One backfilled CPU/MEM point for a pod's detail-header sparkline (B44). */
export interface PodPoint {
  /** Epoch milliseconds — the x axis. */
  ts: number;
  /** CPU usage rate, summed across the pod's containers, in millicores. */
  cpuMillis: number;
  /** Memory working set, summed across the pod's containers, in bytes. */
  memBytes: number;
}

export interface NodeSample {
  /** Epoch milliseconds — the x axis. */
  ts: number;
  /** Busy CPU across all cores, 0–100. */
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** Bytes/second over physical interfaces. */
  netRxBps: number;
  netTxBps: number;
  load1: number;
  load5: number;
  load15: number;
  /** Slow-moving, so shown as a current bar chart rather than a series. */
  filesystems: Filesystem[];
}

/** Why a node has no plots (B27). */
export interface NodeStatsError {
  node: string;
  message: string;
}

/** Unsubscribe function returned by the `on*` event subscriptions. */
export type Unsub = () => void;

/**
 * The full provider contract. See file header for the two implementations.
 */
export interface DataProvider {
  // ---- one-shot commands ----
  /** The switcher list: default kubeconfig contexts plus any imported ones. */
  listContexts(): Promise<ContextInfo[]>;
  connect(context: string): Promise<ClusterInfo>;
  /**
   * Import contexts from a kubeconfig file (via a native file picker). Returns the
   * merged list and the imported path, or null if the user cancelled.
   */
  importKubeconfig(): Promise<ImportResult | null>;
  /**
   * Standalone kubeconfig YAML for one context (M9): the cluster, user, and
   * context entries only. Used to render the QR sequence mk7s on a phone scans.
   */
  exportContextKubeconfig(context: string): Promise<string>;
  /**
   * Re-register previously imported kubeconfig files on boot (B17). Returns the
   * paths that still parse — callers should persist that, dropping the rest.
   * Must run before {@link listContexts} for imports to appear in the switcher.
   */
  restoreImports(paths: string[]): Promise<string[]>;
  getYaml(ref: ResourceRef): Promise<string>;
  /** Rejects with the API error message (shown inline) on failure. */
  applyYaml(ref: ResourceRef, text: string): Promise<void>;
  /**
   * Send an edit as a server-side dry run and return both sides for a diff
   * (B36). Rejects with the server's message when admission refuses it —
   * nothing is written either way.
   */
  dryRunYaml(ref: ResourceRef, text: string): Promise<YamlDiff>;
  getEvents(ref: ResourceRef): Promise<EventItem[]>;
  /**
   * Properties for an object: what it's wired to, as a generic section document.
   * Rejects for kinds without a gatherer — see `KINDS_WITH_PROPERTIES`, which is
   * what stops the tab being offered for them (B13, B18).
   */
  getProperties(ref: ResourceRef): Promise<Properties>;

  /**
   * Copy one Secret value to the system clipboard (B37). The backend decodes and
   * writes it in Rust, so the plaintext never reaches the webview — this call
   * only learns whether the copy succeeded. Rejects for a key that isn't in the
   * Secret.
   */
  copySecretValue(ref: ResourceRef, key: string): Promise<void>;

  // ---- mutations (B3); all reject with the API error message on failure ----
  /** Delete a resource of any kind. */
  deleteResource(ref: ResourceRef): Promise<void>;
  /** Scale a Deployment/StatefulSet to `replicas`. */
  scaleResource(ref: ResourceRef, replicas: number): Promise<void>;
  /**
   * Restart a pod (B34) by deleting it; its controller recreates a fresh one.
   * Rejects for a pod with no controller — that would just delete it.
   */
  restartPod(ref: ResourceRef): Promise<void>;
  /**
   * Rollout-restart a Deployment/StatefulSet/DaemonSet (B34) — the `kubectl
   * rollout restart` template-annotation patch, rolled through the update strategy.
   */
  restartRollout(ref: ResourceRef): Promise<void>;
  /**
   * Roll a Deployment back to a prior ReplicaSet revision (B34b): copy that
   * revision's pod template back onto the Deployment, so the controller rolls to
   * that generation again. Resolves to the revision rolled back to.
   */
  undoRollout(ref: ResourceRef, revision: number): Promise<number>;
  /**
   * Roll a Helm release back to an earlier revision (B81): apply that revision's
   * manifest, mark the current one superseded, and write a new revision Secret
   * the way `helm rollback` does. Resolves to the new revision.
   */
  rollbackRelease(ref: ResourceRef, revision: number): Promise<number>;
  /**
   * Uninstall a Helm release (B81): delete the objects its manifest installs and
   * the release's revision Secrets. Resolves with what was deleted.
   */
  uninstallRelease(ref: ResourceRef): Promise<UninstallOutcome>;
  /** Cordon or uncordon a node. */
  setCordon(node: string, unschedulable: boolean): Promise<void>;
  /** Suspend or resume a CronJob by patching spec.suspend (B47). */
  setCronjobSuspend(ref: ResourceRef, suspended: boolean): Promise<void>;
  /** Run a CronJob's jobTemplate now (B47); resolves to the new Job's name. */
  runCronjob(ref: ResourceRef): Promise<string>;
  /** Retry a failed Job (B47): delete + recreate unowned; resolves to the new name. */
  retryJob(ref: ResourceRef): Promise<string>;
  /**
   * Show a native notification that a problem appeared (B50). `ref.kind` is the
   * nav target a click should jump to; `reason` is the notification body.
   */
  notifyProblem(cid: string, ref: ResourceRef, reason: string): Promise<void>;

  /**
   * Create an object from pasted YAML (B36). The manifest's apiVersion/kind
   * select the resource; metadata.namespace (or `namespace`) places it. With
   * `dryRun` nothing is written — the result is the object as the server would
   * store it, for a preview.
   */
  createResource(
    yaml: string,
    namespace: string,
    dryRun: boolean,
  ): Promise<{ proposed: string; created?: { kind: KindId; namespace?: string; name: string } }>;

  /**
   * The live object and its last-applied baseline, for the Diff tab (B54).
   * `baseline` is absent when neither the last-applied annotation nor
   * apply-managed-fields can reconstruct it.
   */
  getDiff(ref: ResourceRef): Promise<{ live: string; baseline?: string }>;

  /** The ownership/reference graph around a resource (B55). */
  getTopology(ref: ResourceRef): Promise<Topology>;
  /**
   * Drain a node (B20): cordon it, then evict its pods in the background.
   * Resolves once cordoned — watch {@link onDrainProgress} for the rest.
   */
  drainNode(node: string): Promise<void>;
  /**
   * Preview a drain (B61/B80): the node's evictable pods and the PDBs whose
   * disruption math constrains them — shown in the confirm dialog *before* the
   * user commits. Degrades to an empty preview on a restricted cluster.
   */
  drainPreview(node: string): Promise<DrainPreview>;

  /**
   * Tell the OS window which palette the app is using (B52), so the native
   * titlebar and scrollbars match. CSS can't reach window chrome, and this is the
   * only reason the frontend needs the window API — hence it going through the
   * provider rather than importing Tauri into a hook, which would break demo mode
   * in a plain browser. A no-op where there is no native window.
   */
  setWindowTheme(theme: "dark" | "light"): Promise<void>;

  /**
   * Open a root shell on a node's host OS (B53).
   *
   * Creates a privileged pod on that node and `nsenter`s into the host's
   * namespaces — see src-tauri/src/kube/nodeshell.rs for exactly what that grants.
   * Only ever call this from an explicit, confirmed user action; it is not
   * something to do speculatively or on navigation.
   *
   * Resolves once the shell is attached, which can take a while on first use
   * (the node pulls the image). Rejects with an explanation if the pod never
   * starts — a NotReady node and a wrong-architecture image are the usual causes.
   */
  startNodeShell(
    node: string,
    onOutput: (data: string) => void,
    onClosed: (reason: string) => void,
  ): Promise<NodeShellHandle>;

  // ---- node-exporter statistics (B27) ----
  /**
   * Start scraping a node's node-exporter. Lazy, like custom kinds: each scrape
   * moves a few hundred KB and holds a port-forward, so it runs only while the
   * node's Metrics tab is open. Safe to call twice.
   */
  /**
   * Backfill a node's charts from Prometheus (B38), newest last. Resolves to an
   * empty list when the cluster has no Prometheus we recognise — that's the
   * normal no-history case, not a failure, and the live scraper covers it.
   */
  nodeHistory(node: string): Promise<NodeSample[]>;

  /**
   * Backfill a pod's CPU/MEM history for the detail-header sparklines (B44),
   * newest last. Two range queries max, fired when the pod is opened. Resolves
   * to an empty list when the cluster has no Prometheus — the header then
   * renders exactly as before, with nothing surfaced as an error.
   */
  podHistory(namespace: string, name: string): Promise<PodPoint[]>;
  watchNodeStats(node: string): Promise<void>;
  /** Stop scraping a node (idempotent). */
  unwatchNodeStats(node: string): Promise<void>;

  /**
   * Start feeding per-pod usage samples for the pod keyed "namespace/name",
   * emitted through `onPodStats`. Unlike a node, this needs no scraper — the
   * cluster-wide metrics poller is already running — so this only marks the pod
   * as one whose samples should be forwarded. Safe to call twice.
   */
  watchPodStats(key: string): Promise<void>;
  /** Stop forwarding a pod's samples (idempotent). */
  unwatchPodStats(key: string): Promise<void>;

  // ---- persisted preferences (B11) ----
  /** Load persisted UI preferences, or null if none / not supported (demo). */
  loadPrefs(): Promise<Prefs | null>;
  /** Persist UI preferences (no-op in demo mode). */
  savePrefs(prefs: Prefs): Promise<void>;

  // ---- custom (CRD-backed) kinds (B15) ----
  /**
   * Start watching a custom kind. Called when the user opens it — watchers are
   * lazy because a cluster can define hundreds of CRDs. Safe to call twice.
   */
  watchCustomKind(id: string): Promise<void>;
  /** Stop watching a custom kind (idempotent). Called when navigating away. */
  unwatchCustomKind(id: string): Promise<void>;

  // ---- push subscriptions (return an unsubscribe fn) ----
  /**
   * The native File > Settings… menu item was chosen. Fires once per click; the
   * app opens its settings dialog on it. No payload.
   */
  onOpenSettings(cb: () => void): Unsub;
  /** Cluster callbacks lead with the cid (B77) — every provider event is routed
   *  to the cluster it came from, and the store retains per-cid data. */
  onResourceUpdate(cb: (cid: string, kind: KindId, update: RowUpdate) => void): Unsub;
  /** CRD-backed kinds discovered on connect; re-emitted on every connect. */
  onCustomKinds(cb: (cid: string, kinds: CustomKind[]) => void): Unsub;
  onPodMetrics(cb: (cid: string, metrics: PodMetricsMap) => void): Unsub;
  onNodeMetrics(cb: (cid: string, metrics: NodeMetricsMap) => void): Unsub;
  onClusterStatus(cb: (cid: string, status: ClusterStatus) => void): Unsub;
  onWatchStatus(cb: (cid: string, activeStreams: number) => void): Unsub;
  /** Progress of running node drains (B20). */
  onDrainProgress(cb: (cid: string, progress: DrainProgress) => void): Unsub;
  /** node-exporter samples for nodes being watched (B27). */
  onNodeStats(cb: (cid: string, node: string, sample: NodeSample) => void): Unsub;
  /** Why a watched node has no samples (B27). */
  onNodeStatsError(cb: (cid: string, err: NodeStatsError) => void): Unsub;
  /** Per-pod usage samples for pods whose Metrics tab is open, keyed "ns/name". */
  onPodStats(cb: (cid: string, key: string, sample: PodSample) => void): Unsub;

  // ---- log streaming ----
  startLogs(
    ref: ResourceRef,
    container: string,
    opts: LogOptions,
    onLines: (lines: LogLine[]) => void,
    onClosed: (reason: string) => void,
  ): Promise<LogHandle>;

  /**
   * Save a pod's full logs to a file the user picks (B29).
   *
   * Not "save what's on screen": the view holds a ring buffer, and the reason to
   * export is usually the part that scrolled away — so this re-reads with no tail
   * cap. Returns null if the user cancelled the save dialog.
   */
  saveLogs(
    ref: ResourceRef,
    container: string,
    opts: { sinceSeconds?: number; previous?: boolean },
  ): Promise<SavedLog | null>;

  /**
   * Start a workload log bundle (B31): every pod a Deployment/StatefulSet/
   * DaemonSet selects, interleaved into one stream. Lines carry a `pod` field.
   * Same lifecycle as {@link startLogs} — a {@link LogHandle} whose stop tears
   * down all per-pod pumps.
   */
  startWorkloadLogs(
    ref: ResourceRef,
    opts: LogOptions,
    onLines: (lines: LogLine[]) => void,
    onClosed: (reason: string) => void,
  ): Promise<LogHandle>;

  /**
   * Save a workload's full logs to a file the user picks (B31), each pod
   * labelled in the file. Returns null if the user cancelled the save dialog.
   */
  saveWorkloadLogs(
    ref: ResourceRef,
    opts: { sinceSeconds?: number },
  ): Promise<SavedLog | null>;

  // ---- shell / exec (B4) ----
  startShell(
    ref: ResourceRef,
    container: string,
    onOutput: (data: string) => void,
    onClosed: (reason: string) => void,
  ): Promise<ShellHandle>;

  // ---- port-forwarding (B6, B16) ----
  /**
   * Forward a port. `ref.kind` selects the strategy: a pod forwards directly; a
   * Service resolves to a Ready backing pod first, and `remotePort` is then the
   * *service* port rather than the pod's (B16).
   */
  startPortForward(ref: ResourceRef, remotePort: number): Promise<ForwardInfo>;
  stopPortForward(id: string): Promise<void>;
  listPortForwards(): Promise<ForwardInfo[]>;
  /** Active forwards, pushed on add/remove/failure (B16). */
  onForwards(cb: (cid: string, forwards: ForwardInfo[]) => void): Unsub;
}
