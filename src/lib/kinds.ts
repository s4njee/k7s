/**
 * Static metadata for each resource kind: nav group, display label, glyph
 * icon, and the exact column set (order + labels) for each kind's table.
 *
 * This is the *column contract*: the Rust DTO layer (and the MockProvider) must
 * emit each row's `cells` array in exactly this column order. Transcribed from the
 * prototype's `resourceDefs` and the Pods branch of its render (design/K8s Monitor.dc.html).
 */

import type { ResourceKind } from "../providers/types";

// Re-export so consumers can pull the kind type and its metadata from one module.
export type { ResourceKind } from "../providers/types";

/** Nav groups, in sidebar order. */
export type NavGroup = "workloads" | "network" | "config" | "cluster";

/** Human-readable group headers (mono uppercase in the sidebar). */
export const GROUP_LABELS: Record<NavGroup, string> = {
  workloads: "Workloads",
  network: "Network",
  config: "Config",
  cluster: "Cluster",
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

/** All kinds in sidebar order (Pods → Namespaces). */
export const KIND_ORDER = Object.keys(KIND_META) as ResourceKind[];

/** Kinds that are cluster-scoped and therefore ignore the namespace filter. */
export const CLUSTER_SCOPED: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  "nodes",
  "namespaces",
]);

/** Groups in sidebar order. */
export const GROUP_ORDER: NavGroup[] = ["workloads", "network", "config", "cluster"];
