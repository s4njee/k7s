//! Kubernetes integration: kubeconfig/contexts, the client manager, per-kind
//! watchers that stream row snapshots, log streaming, and metrics/status pollers.
//!
//! Everything the frontend sees flows through the DTOs in [`dto`] and the Tauri
//! events named in [`events`].

pub mod client;
pub mod discovery;
pub mod drain;
pub mod dto;
pub mod exec;
pub mod exporter;
pub mod helm;
pub mod logs;
pub mod manager;
pub mod mappers;
pub mod metrics;
pub mod nodeshell;
pub mod nodestats;
pub mod portforward;
pub mod promql;
pub mod properties;
pub mod restart;
pub mod watchers;

use serde::{Deserialize, Serialize};

pub use dto::Row;
pub use manager::ClientManager;

/// The twelve resource kinds the app watches. Serializes to the same lowercase
/// ids the frontend uses (see src/lib/kinds.ts).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Pods,
    Deployments,
    /// The generation a Deployment actually runs; also a pod's immediate owner.
    Replicasets,
    Statefulsets,
    Daemonsets,
    Jobs,
    Cronjobs,
    Services,
    Ingresses,
    /// The controller an Ingress is handled by (cluster-scoped).
    Ingressclasses,
    Configmaps,
    Secrets,
    /// The identity a pod runs as.
    Serviceaccounts,
    /// Storage claims (namespaced) and the volumes that back them (cluster-scoped).
    Persistentvolumeclaims,
    Persistentvolumes,
    /// The classes claims are provisioned from (cluster-scoped).
    Storageclasses,
    Nodes,
    Namespaces,
    /// Cluster-wide event feed (B14) — a read-only view, not a managed resource.
    Events,
    /// Helm releases (B26) — decoded from Helm's release Secrets; read-only.
    Helm,
}

impl ResourceKind {
    /// The lowercase id string (matches the frontend and serde rename).
    pub fn id(&self) -> &'static str {
        match self {
            ResourceKind::Pods => "pods",
            ResourceKind::Deployments => "deployments",
            ResourceKind::Replicasets => "replicasets",
            ResourceKind::Statefulsets => "statefulsets",
            ResourceKind::Daemonsets => "daemonsets",
            ResourceKind::Jobs => "jobs",
            ResourceKind::Cronjobs => "cronjobs",
            ResourceKind::Services => "services",
            ResourceKind::Ingresses => "ingresses",
            ResourceKind::Ingressclasses => "ingressclasses",
            ResourceKind::Configmaps => "configmaps",
            ResourceKind::Secrets => "secrets",
            ResourceKind::Serviceaccounts => "serviceaccounts",
            ResourceKind::Persistentvolumeclaims => "persistentvolumeclaims",
            ResourceKind::Persistentvolumes => "persistentvolumes",
            ResourceKind::Storageclasses => "storageclasses",
            ResourceKind::Nodes => "nodes",
            ResourceKind::Namespaces => "namespaces",
            ResourceKind::Events => "events",
            ResourceKind::Helm => "helm",
        }
    }
}

/// Tauri event names emitted to the webview. Kept in one place so the frontend
/// (TauriProvider) and backend agree on the wire contract.
pub mod events {
    /// Full row snapshot for a kind: `{ kind, rows }`. Debounced per kind.
    pub const RESOURCE_UPDATE: &str = "resource-update";
    /// CRD-backed kinds discovered on connect (B15): `[{ id, group, kind, … }]`.
    pub const CUSTOM_KINDS: &str = "custom-kinds";
    /// Pod usage keyed by "ns/name": `{ [key]: { cpuMillis, memBytes } }`.
    pub const POD_METRICS: &str = "pod-metrics";
    /// Node usage percentages keyed by node name: `{ [name]: { cpuPercent, memPercent } }`.
    pub const NODE_METRICS: &str = "node-metrics";
    /// Cluster-wide status for the status bar / switcher.
    pub const CLUSTER_STATUS: &str = "cluster-status";
    /// Count of live watcher + log-stream tasks (sidebar footer).
    pub const WATCH_STATUS: &str = "watch-status";
    /// The active port-forwards, pushed whenever one is added, removed, or fails
    /// (B16) — so the strip reflects failures without the UI polling for them.
    pub const FORWARDS_UPDATE: &str = "forwards-update";
    /// One node-exporter sample for a node (B27): `{ node, sample }`. Only while
    /// that node's Metrics tab is open.
    pub const NODE_STATS: &str = "node-stats";
    /// Why a node has no plots (B27): `{ node, message }`.
    pub const NODE_STATS_ERROR: &str = "node-stats-error";
    /// Progress of a node drain (B20): `{ node, evicted, total, failures, done }`.
    /// One event carrying the node, rather than a per-node channel, so progress
    /// lands in the store and survives navigating away mid-drain.
    pub const DRAIN_PROGRESS: &str = "drain-progress";
    /// Log lines for a stream: emitted as `log-line:{streamId}`.
    pub const LOG_LINE_PREFIX: &str = "log-line:";
    /// Stream end/error: emitted as `log-closed:{streamId}`.
    pub const LOG_CLOSED_PREFIX: &str = "log-closed:";
}

/// Payload for [`events::RESOURCE_UPDATE`].
///
/// `kind` is the frontend kind id as a string rather than a [`ResourceKind`]:
/// custom (CRD-backed) kinds aren't in that enum, and their ids are "group/plural"
/// (B15). Built-in kinds pass `ResourceKind::id()`, so the wire format is
/// unchanged either way.
#[derive(Serialize, Clone)]
pub struct ResourceUpdate {
    pub kind: String,
    pub rows: Vec<Row>,
}
