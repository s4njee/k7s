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
export type NavGroup = "workloads" | "network" | "config" | "cluster" | "custom";

/** Human-readable group headers (mono uppercase in the sidebar). */
export const GROUP_LABELS: Record<NavGroup, string> = {
  workloads: "Workloads",
  network: "Network",
  config: "Config",
  cluster: "Cluster",
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
    columns: ["NAME", "NAMESPACE", "SCHEDULE", "LAST RUN", "AGE"],
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
  // ---- Cluster (cluster-scoped: no NAMESPACE column) ----
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
  // A read-only feed rather than a managed resource, but it lives in the Cluster
  // group because it is cluster-wide. It *is* namespaced, so it keeps a NAMESPACE
  // column and honours the namespace filter.
  events: {
    group: "cluster",
    label: "Events",
    icon: "☲",
    columns: ["TYPE", "REASON", "OBJECT", "NAMESPACE", "AGE", "COUNT", "MESSAGE"],
  },
};

/** All built-in kinds in sidebar order (Pods → Events). */
export const KIND_ORDER = Object.keys(KIND_META) as ResourceKind[];

/** Built-in kinds that are cluster-scoped and therefore ignore the namespace filter. */
const CLUSTER_SCOPED: ReadonlySet<string> = new Set<string>(["nodes", "namespaces"]);

/** Groups in sidebar order. */
export const GROUP_ORDER: NavGroup[] = ["workloads", "network", "config", "cluster", "custom"];

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

/** Icon for every custom kind (they have no per-kind glyph of their own). */
const CUSTOM_ICON = "◈";

/**
 * Generic columns for a CRD-backed kind. A CRD's schema is arbitrary, so there's
 * nothing meaningful to show beyond identity and age without per-CRD knowledge —
 * the YAML tab carries the detail. Must match the backend's `map_dynamic`.
 */
function customColumns(namespaced: boolean): string[] {
  return namespaced ? ["NAME", "NAMESPACE", "AGE"] : ["NAME", "AGE"];
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
    columns: customColumns(ck.namespaced),
  };
}

/** Whether a kind ignores the namespace filter (cluster-scoped). */
export function isClusterScoped(id: KindId, customKinds: CustomKind[]): boolean {
  if (!isCustomKind(id)) return CLUSTER_SCOPED.has(id);
  const ck = customKinds.find((k) => k.id === id);
  // Unknown custom kinds have no rows to filter; treat as namespaced.
  return ck ? !ck.namespaced : false;
}
