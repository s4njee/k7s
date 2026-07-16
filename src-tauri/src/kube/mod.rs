//! Kubernetes integration: kubeconfig/contexts, the client manager, per-kind
//! watchers that stream row snapshots, log streaming, and metrics/status pollers.
//!
//! Everything the frontend sees flows through the DTOs in [`dto`] and the Tauri
//! events named in [`events`].

pub mod client;
pub mod dto;
pub mod exec;
pub mod logs;
pub mod manager;
pub mod mappers;
pub mod metrics;
pub mod portforward;
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
    Statefulsets,
    Daemonsets,
    Jobs,
    Cronjobs,
    Services,
    Ingresses,
    Configmaps,
    Secrets,
    Nodes,
    Namespaces,
}

impl ResourceKind {
    /// The lowercase id string (matches the frontend and serde rename).
    pub fn id(&self) -> &'static str {
        match self {
            ResourceKind::Pods => "pods",
            ResourceKind::Deployments => "deployments",
            ResourceKind::Statefulsets => "statefulsets",
            ResourceKind::Daemonsets => "daemonsets",
            ResourceKind::Jobs => "jobs",
            ResourceKind::Cronjobs => "cronjobs",
            ResourceKind::Services => "services",
            ResourceKind::Ingresses => "ingresses",
            ResourceKind::Configmaps => "configmaps",
            ResourceKind::Secrets => "secrets",
            ResourceKind::Nodes => "nodes",
            ResourceKind::Namespaces => "namespaces",
        }
    }
}

/// Tauri event names emitted to the webview. Kept in one place so the frontend
/// (TauriProvider) and backend agree on the wire contract.
pub mod events {
    /// Full row snapshot for a kind: `{ kind, rows }`. Debounced per kind.
    pub const RESOURCE_UPDATE: &str = "resource-update";
    /// Pod usage keyed by "ns/name": `{ [key]: { cpuMillis, memBytes } }`.
    pub const POD_METRICS: &str = "pod-metrics";
    /// Node usage percentages keyed by node name: `{ [name]: { cpuPercent, memPercent } }`.
    pub const NODE_METRICS: &str = "node-metrics";
    /// Cluster-wide status for the status bar / switcher.
    pub const CLUSTER_STATUS: &str = "cluster-status";
    /// Count of live watcher + log-stream tasks (sidebar footer).
    pub const WATCH_STATUS: &str = "watch-status";
    /// Log lines for a stream: emitted as `log-line:{streamId}`.
    pub const LOG_LINE_PREFIX: &str = "log-line:";
    /// Stream end/error: emitted as `log-closed:{streamId}`.
    pub const LOG_CLOSED_PREFIX: &str = "log-closed:";
}

/// Payload for [`events::RESOURCE_UPDATE`].
#[derive(Serialize, Clone)]
pub struct ResourceUpdate {
    pub kind: ResourceKind,
    pub rows: Vec<Row>,
}
