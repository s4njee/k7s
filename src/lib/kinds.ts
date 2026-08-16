/**
 * Static metadata for each resource kind: nav group, display label, glyph
 * icon, and the exact column set (order + labels) for each kind's table.
 *
 * This is the *column contract*: the Rust DTO layer (and the MockProvider) must
 * emit each row's `cells` array in exactly this column order. Transcribed from the
 * prototype's `resourceDefs` and the Pods branch of its render (design/K8s Monitor.dc.html).
 */

import type { CustomKind, KindId, ResourceKind } from "../providers/types";

// Re-export so consumers can pull the kind type and its metadata from one module.
export type { CustomKind, KindId, ResourceKind } from "../providers/types";

/** Nav groups, in sidebar order. "custom" holds discovered CRD kinds (B15). */
export type NavGroup =
  | "workloads"
  | "network"
  | "config"
  | "storage"
  | "cluster"
  | "helm"
  | "access"
  | "custom";

/** Human-readable group headers (mono uppercase in the sidebar). */
export const GROUP_LABELS: Record<NavGroup, string> = {
  workloads: "Workloads",
  network: "Network",
  config: "Config",
  storage: "Storage",
  cluster: "Cluster",
  helm: "Helm",
  access: "Access",
  custom: "Custom",
};

export interface KindMeta {
  group: NavGroup;
  /** Sidebar + breadcrumb label, e.g. "StatefulSets". */
  label: string;
  /** Unicode glyph icon (11px in the sidebar), per the prototype. */
  icon: string;
  /** Table column headers, in order. Row cells must align to this. */
  columns: string[];
}

/**
 * The kind registry. Insertion order is the sidebar order within each group, so
 * iterating `Object.entries(KIND_META)` yields Pods…Namespaces top-to-bottom.
 */
export const KIND_META: Record<ResourceKind, KindMeta> = {
  // ---- Workloads ----
  pods: {
    group: "workloads",
    label: "Pods",
    icon: "◉",
    columns: ["NAME", "NAMESPACE", "READY", "RESTARTS", "CPU", "MEM", "AGE", "STATUS"],
  },
  deployments: {
    group: "workloads",
    label: "Deployments",
    icon: "▲",
    columns: ["NAME", "NAMESPACE", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"],
  },
  // A Deployment's actual generation, and a pod's immediate owner — the object
  // the owner chain used to have to route around (B33).
  replicasets: {
    group: "workloads",
    label: "ReplicaSets",
    icon: "❐",
    columns: ["NAME", "NAMESPACE", "DESIRED", "CURRENT", "READY", "AGE"],
  },
  statefulsets: {
    group: "workloads",
    label: "StatefulSets",
    icon: "≡",
    columns: ["NAME", "NAMESPACE", "READY", "AGE"],
  },
  daemonsets: {
    group: "workloads",
    label: "DaemonSets",
    icon: "⦿",
    columns: ["NAME", "NAMESPACE", "DESIRED", "READY", "AGE"],
  },
  jobs: {
    group: "workloads",
    label: "Jobs",
    icon: "▸",
    columns: ["NAME", "NAMESPACE", "COMPLETIONS", "DURATION", "AGE"],
  },
  cronjobs: {
    group: "workloads",
    label: "CronJobs",
    icon: "↻",
    columns: ["NAME", "NAMESPACE", "SCHEDULE", "SUSPENDED", "LAST RUN", "AGE"],
  },
  // B80: autoscaling + disruption budgets — the two "why is it doing this"
  // questions about a workload's size and drain-ability.
  horizontalpodautoscalers: {
    group: "workloads",
    label: "HPA",
    icon: "↕",
    columns: ["NAME", "NAMESPACE", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"],
  },
  poddisruptionbudgets: {
    group: "workloads",
    label: "PDBs",
    icon: "⛨",
    columns: ["NAME", "NAMESPACE", "MIN AVAILABLE", "MAX UNAVAILABLE", "CURRENT HEALTHY", "DISRUPTIONS ALLOWED", "AGE"],
  },
  // ---- Network ----
  services: {
    group: "network",
    label: "Services",
    icon: "⇄",
    columns: ["NAME", "NAMESPACE", "TYPE", "CLUSTER-IP", "PORTS", "AGE"],
  },
  ingresses: {
    group: "network",
    label: "Ingresses",
    icon: "⇥",
    columns: ["NAME", "NAMESPACE", "HOSTS", "CLASS", "AGE"],
  },
  // B80: the "why can't this connect" kind.
  networkpolicies: {
    group: "network",
    label: "NetworkPolicies",
    icon: "⇥",
    columns: ["NAME", "NAMESPACE", "POD-SELECTOR", "AGE"],
  },
  // Cluster-scoped; the default is marked in the NAME, as kubectl does.
  ingressclasses: {
    group: "network",
    label: "IngressClasses",
    icon: "⇉",
    columns: ["NAME", "CONTROLLER", "PARAMETERS", "AGE"],
  },
  // ---- Config ----
  configmaps: {
    group: "config",
    label: "ConfigMaps",
    icon: "☰",
    columns: ["NAME", "NAMESPACE", "DATA", "AGE"],
  },
  secrets: {
    group: "config",
    label: "Secrets",
    icon: "⚿",
    columns: ["NAME", "NAMESPACE", "TYPE", "DATA", "AGE"],
  },
  // B80: the "why won't anything schedule here" kinds.
  resourcequotas: {
    group: "config",
    label: "ResourceQuotas",
    icon: "☰",
    columns: ["NAME", "NAMESPACE", "REQUEST", "LIMIT", "AGE"],
  },
  limitranges: {
    group: "config",
    label: "LimitRanges",
    icon: "☰",
    columns: ["NAME", "NAMESPACE", "TYPES", "AGE"],
  },
  // ---- Access (B49) ----
  // The identity a pod runs as, and the roles/bindings that grant it access.
  serviceaccounts: {
    group: "access",
    label: "ServiceAccounts",
    icon: "☺",
    columns: ["NAME", "NAMESPACE", "SECRETS", "AGE"],
  },
  roles: {
    group: "access",
    label: "Roles",
    icon: "⚷",
    columns: ["NAME", "NAMESPACE", "RULES", "AGE"],
  },
  clusterroles: {
    group: "access",
    label: "ClusterRoles",
    icon: "⚿",
    columns: ["NAME", "RULES", "AGE"],
  },
  rolebindings: {
    group: "access",
    label: "RoleBindings",
    icon: "⛓",
    columns: ["NAME", "NAMESPACE", "ROLE", "SUBJECTS", "AGE"],
  },
  clusterrolebindings: {
    group: "access",
    label: "ClusterRoleBindings",
    icon: "⛓",
    columns: ["NAME", "ROLE", "SUBJECTS", "AGE"],
  },
  // ---- Storage ----
  // Claims first: a claim is what a workload actually references, and the volume
  // behind it is the follow-up question.
  persistentvolumeclaims: {
    group: "storage",
    label: "PVCs",
    icon: "⛁",
    columns: ["NAME", "NAMESPACE", "STATUS", "VOLUME", "CAPACITY", "ACCESS", "CLASS", "AGE"],
  },
  // Cluster-scoped, so no NAMESPACE column — CLAIM carries "namespace/name".
  persistentvolumes: {
    group: "storage",
    label: "PersistentVolumes",
    icon: "⛃",
    columns: ["NAME", "CAPACITY", "ACCESS", "RECLAIM", "STATUS", "CLAIM", "CLASS", "AGE"],
  },
  // Cluster-scoped. The default class is marked in the NAME, as kubectl does.
  storageclasses: {
    group: "storage",
    label: "StorageClasses",
    icon: "▧",
    columns: ["NAME", "PROVISIONER", "RECLAIM", "BINDING", "EXPANSION", "AGE"],
  },
  // ---- Cluster (cluster-scoped: no NAMESPACE column) ----
  // First, because "is anything wrong?" is the first question a cluster view
  // should answer (B32). A frontend-only aggregation over the other kinds' rows —
  // its table renders what deriveProblems produces, and never opens a panel.
  problems: {
    group: "cluster",
    label: "Problems",
    icon: "✕",
    columns: ["SEVERITY", "KIND", "OBJECT", "REASON", "AGE"],
  },
  // The overview pseudo-kind (B79): a frontend-only dashboard — no watcher,
  // no YAML, just a landing page after connect.
  overview: {
    group: "cluster",
    label: "Overview",
    icon: "◉",
    columns: [],
  },
  nodes: {
    group: "cluster",
    label: "Nodes",
    icon: "▢",
    columns: ["NAME", "STATUS", "ROLES", "CPU", "MEMORY", "VERSION"],
  },
  namespaces: {
    group: "cluster",
    label: "Namespaces",
    icon: "◫",
    columns: ["NAME", "STATUS", "PODS", "AGE"],
  },
  // B80: cluster-scoped admission configuration — "why was this rejected?".
  mutatingwebhookconfigurations: {
    group: "cluster",
    label: "MutatingWebhooks",
    icon: "✚",
    columns: ["NAME", "WEBHOOKS", "AGE"],
  },
  validatingwebhookconfigurations: {
    group: "cluster",
    label: "ValidatingWebhooks",
    icon: "✓",
    columns: ["NAME", "WEBHOOKS", "AGE"],
  },
  // B90: built-in resource coverage, wave 2.
  priorityclasses: {
    group: "cluster",
    label: "PriorityClasses",
    icon: "⚠",
    columns: ["NAME", "VALUE", "GLOBAL-DEFAULT", "AGE"],
  },
  runtimeclasses: {
    group: "cluster",
    label: "RuntimeClasses",
    icon: "⌗",
    columns: ["NAME", "HANDLER", "AGE"],
  },
  leases: {
    group: "config",
    label: "Leases",
    icon: "⚿",
    columns: ["NAME", "HOLDER", "AGE"],
  },
  replicationcontrollers: {
    group: "workloads",
    label: "ReplicationControllers",
    icon: "▦",
    columns: ["NAME", "DESIRED", "CURRENT", "READY", "AGE"],
  },
  endpoints: {
    group: "network",
    label: "Endpoints",
    icon: "◎",
    columns: ["NAME", "ENDPOINTS", "AGE"],
  },
  endpointslices: {
    group: "network",
    label: "EndpointSlices",
    icon: "◍",
    columns: ["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"],
  },
  // Admission policies: cluster-scoped, evaluated against objects on admission.
  validatingadmissionpolicies: {
    group: "cluster",
    label: "ValidatingAdmissionPolicies",
    icon: "§",
    columns: ["NAME", "FAILURE POLICY", "VALIDATIONS", "AGE"],
  },
  validatingadmissionpolicybindings: {
    group: "cluster",
    label: "AdmissionPolicyBindings",
    icon: "§",
    columns: ["NAME", "POLICY NAME", "PARAM REF", "AGE"],
  },
  mutatingadmissionpolicies: {
    group: "cluster",
    label: "MutatingAdmissionPolicies",
    icon: "✎",
    columns: ["NAME", "FAILURE POLICY", "MUTATIONS", "AGE"],
  },
  mutatingadmissionpolicybindings: {
    group: "cluster",
    label: "AdmissionPolicyBindings",
    icon: "✎",
    columns: ["NAME", "POLICY NAME", "PARAM REF", "AGE"],
  },
  // A read-only feed rather than a managed resource, but it lives in the Cluster
  // group because it is cluster-wide. It *is* namespaced, so it keeps a NAMESPACE
  // column and honours the namespace filter.
  events: {
    group: "cluster",
    label: "Events",
    icon: "☲",
    columns: ["TYPE", "REASON", "OBJECT", "NAMESPACE", "AGE", "COUNT", "MESSAGE"],
  },
  // ---- Helm (B26) ----
  // Its own group, as in Lens: a release isn't a Kubernetes kind, it's a thing
  // Helm keeps *in* Kubernetes, and filing it under Config next to the Secrets it
  // happens to be stored in would say the wrong thing about what it is.
  helm: {
    group: "helm",
    label: "Releases",
    icon: "⎈",
    columns: ["NAME", "NAMESPACE", "CHART", "APP VERSION", "REVISION", "STATUS", "UPDATED"],
  },
};

/** All built-in kinds in sidebar order (Pods → Events). */
export const KIND_ORDER = Object.keys(KIND_META) as ResourceKind[];

/** Built-in kinds that are cluster-scoped and therefore ignore the namespace filter. */
const CLUSTER_SCOPED: ReadonlySet<string> = new Set<string>([
  // Problems span every namespace by design — "is anything wrong?" is a
  // cluster-wide question, and a namespace filter would hide a NotReady node.
  "problems",
  "overview",
  "nodes",
  "namespaces",
  "persistentvolumes",
  "storageclasses",
  "ingressclasses",
  "clusterroles",
  "clusterrolebindings",
  // B80: admission webhook configurations are cluster-scoped.
  "mutatingwebhookconfigurations",
  "validatingwebhookconfigurations",
  // B90: scheduling/runtime/admission-policy kinds are cluster-scoped.
  "priorityclasses",
  "runtimeclasses",
  "validatingadmissionpolicies",
  "validatingadmissionpolicybindings",
  "mutatingadmissionpolicies",
  "mutatingadmissionpolicybindings",
]);

/** Groups in sidebar order. */
export const GROUP_ORDER: NavGroup[] = [
  "workloads",
  "network",
  "config",
  "storage",
  "cluster",
  "helm",
  "access",
  "custom",
];

/**
 * Kinds with a properties gatherer (B13, B18). Must match the `match` in
 * src-tauri/src/kube/properties.rs `gather` — a kind listed here without a
 * gatherer would show a tab that only ever errors, and one with a gatherer but
 * missing here just doesn't offer the tab.
 */
export const KINDS_WITH_PROPERTIES: ReadonlySet<string> = new Set<string>([
  "pods",
  "deployments",
  "services",
  "statefulsets",
  "nodes",
  "helm",
  "ingresses",
  // B46: the storage kinds and ReplicaSets grew panels of their own.
  "persistentvolumeclaims",
  "persistentvolumes",
  "replicasets",
  // B37: Secrets get a data-keys panel with per-key copy buttons.
  "secrets",
  // B49: the SA panel shows the RBAC chain; the bindings panels check subjects.
  "serviceaccounts",
  "rolebindings",
  "clusterrolebindings",
  // B80: the kind sweep's panels (HPA metrics/conditions, PDB math, policy
  // rules, quota fill), plus the Namespaces panel that answers quota fill.
  "horizontalpodautoscalers",
  "poddisruptionbudgets",
  "networkpolicies",
  "resourcequotas",
  "limitranges",
  "mutatingwebhookconfigurations",
  "validatingwebhookconfigurations",
  "namespaces",
]);

/** Detail-panel tabs, in strip order. Mirrors DetailTab in the store. */
export type DetailTabId =
  | "logs"
  | "properties"
  | "metrics"
  | "shell"
  | "yaml"
  | "events"
  | "diff"
  | "topology";

/** Tab id → label, in the order the strip renders them. */
export const DETAIL_TABS: { id: DetailTabId; label: string }[] = [
  { id: "logs", label: "Logs" },
  { id: "properties", label: "Properties" },
  { id: "metrics", label: "Metrics" },
  { id: "shell", label: "Shell" },
  { id: "yaml", label: "YAML" },
  { id: "diff", label: "Diff" },
  { id: "topology", label: "Topology" },
  { id: "events", label: "Events" },
];

/**
 * Workload kinds whose Logs tab is a stern-style bundle of every matching pod's
 * logs (B31) — Deployments, StatefulSets, DaemonSets. Must match the backend's
 * `start_workload_logs` kinds.
 */
const LOG_BUNDLE_KINDS: ReadonlySet<string> = new Set([
  "deployments",
  "statefulsets",
  "daemonsets",
]);

/**
 * Kinds whose Topology tab (B55) has a graph: ownership chains plus
 * selector/backend references. A Helm release isn't a real API object, and the
 * cluster/config kinds have no relationships to walk.
 */
const TOPOLOGY_KINDS: ReadonlySet<string> = new Set([
  "pods",
  "deployments",
  "replicasets",
  "statefulsets",
  "daemonsets",
  "jobs",
  "cronjobs",
  "services",
  "ingresses",
]);

/**
 * Whether a kind's Logs tab can be shown: pods stream a container's logs
 * directly (B7), and the workload kinds stream a bundle of every matching pod's
 * logs (B31). Everything else has nothing to read.
 */
export function hasLogs(kind: KindId, isPod: boolean): boolean {
  return isPod || LOG_BUNDLE_KINDS.has(kind);
}

/**
 * Which tabs a selected object gets.
 *
 * One source of truth, because there are three consumers that must agree: the
 * tab strip, the body that renders beneath it, and the `[`/`]` cycle keys. They
 * had already drifted — the cycle keys still believed non-pods had only
 * YAML+Events, which stopped being true when Properties grew past pods (B18),
 * Metrics arrived (B27) and Helm dropped Events (B26). Cycling would have landed
 * on tabs that weren't there.
 *
 * The rules: Logs needs something to read — a pod's containers, or a workload's
 * pod bundle (B31). Shell is pods *or* nodes — a node's shell is a different
 * mechanism (a privileged debug pod; see B53) but the same tab from the user's
 * point of view. Properties needs a backend gatherer. Metrics is pods *or*
 * nodes — a node's come from its node-exporter, a pod's from metrics.k8s.io —
 * again the same tab either way. A Helm release has no Kubernetes events of its
 * own.
 */
export function tabsFor(kind: KindId, isPod: boolean): DetailTabId[] {
  return DETAIL_TABS.filter((t) => {
    switch (t.id) {
      case "logs":
        return hasLogs(kind, isPod);
      case "shell":
        return isPod || kind === "nodes";
      case "properties":
        return KINDS_WITH_PROPERTIES.has(kind);
      case "metrics":
        return isPod || kind === "nodes";
      case "events":
        return kind !== "helm";
      case "diff":
        // A Helm release's YAML is a *rendered manifest*, not an API object —
        // there's no last-applied baseline to diff it against (B54).
        return kind !== "helm";
      case "topology":
        // The graph walks ownership + selector/backend references, which only
        // the workload/network/config kinds carry (B55). A Helm release is a
        // rendered manifest, not a real object.
        return TOPOLOGY_KINDS.has(kind);
      default:
        return true;
    }
  }).map((t) => t.id);
}

// ---------------------------------------------------------------------------
// Custom (CRD-backed) kinds — B15
// ---------------------------------------------------------------------------

/**
 * True when `id` refers to a discovered CRD kind rather than a built-in one.
 * Custom ids are "group/plural"; built-in ids are bare plurals, so the slash is
 * an unambiguous test (a Kubernetes group name always contains a dot, never a
 * slash, and a plural contains neither).
 */
export function isCustomKind(id: KindId): boolean {
  return id.includes("/");
}

/**
 * Kubernetes Kind (PascalCase) → built-in nav id, for the kinds we list. Used to
 * resolve an event's involvedObject to a navigable table (B33).
 */
const BUILTIN_KIND_TO_NAV: Record<string, ResourceKind> = {
  Pod: "pods",
  Deployment: "deployments",
  ReplicaSet: "replicasets",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Job: "jobs",
  CronJob: "cronjobs",
  Service: "services",
  Ingress: "ingresses",
  IngressClass: "ingressclasses",
  ConfigMap: "configmaps",
  Secret: "secrets",
  ServiceAccount: "serviceaccounts",
  PersistentVolumeClaim: "persistentvolumeclaims",
  PersistentVolume: "persistentvolumes",
  StorageClass: "storageclasses",
  Node: "nodes",
  Namespace: "namespaces",
  // B80 kind sweep — events referencing these resolve to their tables.
  HorizontalPodAutoscaler: "horizontalpodautoscalers",
  PodDisruptionBudget: "poddisruptionbudgets",
  NetworkPolicy: "networkpolicies",
  ResourceQuota: "resourcequotas",
  LimitRange: "limitranges",
  MutatingWebhookConfiguration: "mutatingwebhookconfigurations",
  ValidatingWebhookConfiguration: "validatingwebhookconfigurations",
  // B90 — the wave-2 kinds, for event/owner resolution.
  PriorityClass: "priorityclasses",
  RuntimeClass: "runtimeclasses",
  Lease: "leases",
  ReplicationController: "replicationcontrollers",
  Endpoints: "endpoints",
  EndpointSlice: "endpointslices",
  ValidatingAdmissionPolicy: "validatingadmissionpolicies",
  ValidatingAdmissionPolicyBinding: "validatingadmissionpolicybindings",
  MutatingAdmissionPolicy: "mutatingadmissionpolicies",
  MutatingAdmissionPolicyBinding: "mutatingadmissionpolicybindings",
};

/**
 * Resolve an object's Kubernetes Kind (plus its apiVersion, needed to
 * disambiguate CRDs) to the nav id of a table we show, or null when we don't list
 * that kind (B33). A null result is why an event row stays inert rather than
 * dead-clicking.
 *
 * Built-ins match by Kind alone. A CRD matches a discovered `CustomKind` by both
 * Kind and group (the group is the part of `apiVersion` before the slash) — Kind
 * alone can collide across groups (two CRDs both named `Application`).
 */
export function navIdForKind(
  kind: string,
  apiVersion: string | undefined,
  customKinds: CustomKind[],
): KindId | null {
  const builtin = BUILTIN_KIND_TO_NAV[kind];
  if (builtin) return builtin;
  const group = apiVersion && apiVersion.includes("/") ? apiVersion.split("/")[0] : "";
  const ck = customKinds.find((c) => c.kind === kind && c.group === group);
  return ck ? ck.id : null;
}

/** Icon for every custom kind (they have no per-kind glyph of their own). */
const CUSTOM_ICON = "◈";

/**
 * Columns for a CRD-backed kind (B30). A CRD's schema is arbitrary, so without
 * per-CRD knowledge the generic set is NAME, NAMESPACE?, AGE; the CRD's own
 * printer columns (when it declares any) sit between NAMESPACE and AGE, exactly
 * where the backend's `map_dynamic` places the cells. Must match it.
 */
function customColumns(ck: CustomKind): string[] {
  const cols = ck.namespaced ? ["NAME", "NAMESPACE"] : ["NAME"];
  for (const pc of ck.printerColumns ?? []) cols.push(pc.name);
  cols.push("AGE");
  return cols;
}

/**
 * Metadata for any kind: the static entry for built-ins, or a derived one for a
 * discovered custom kind. Returns undefined for an id that is neither (e.g. a
 * persisted nav pointing at a CRD that no longer exists on this cluster).
 */
export function kindMeta(id: KindId, customKinds: CustomKind[]): KindMeta | undefined {
  if (!isCustomKind(id)) return KIND_META[id as ResourceKind];
  const ck = customKinds.find((k) => k.id === id);
  if (!ck) return undefined;
  return {
    group: "custom",
    // The Kind name reads better than the plural ("Application", not "applications").
    label: ck.kind,
    icon: CUSTOM_ICON,
    columns: customColumns(ck),
  };
}

/** Whether a kind ignores the namespace filter (cluster-scoped). */
export function isClusterScoped(id: KindId, customKinds: CustomKind[]): boolean {
  if (!isCustomKind(id)) return CLUSTER_SCOPED.has(id);
  const ck = customKinds.find((k) => k.id === id);
  // Unknown custom kinds have no rows to filter; treat as namespaced.
  return ck ? !ck.namespaced : false;
}
