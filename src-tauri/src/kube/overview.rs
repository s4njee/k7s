//! Cluster overview aggregation (B79): the one piece of the dashboard that
//! isn't already in the store — absolute allocatable capacity. Pod requests and
//! usage are derived on the frontend from the pod rows (`row.pod.resources`) and
//! cluster-status percentages; allocatable is read here from the Node objects
//! and never emitted elsewhere.

use k8s_openapi::api::core::v1::Node;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;

/// Cluster-wide allocatable capacity, summed from `Node.status.allocatable`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
    pub cpu_allocatable_millis: i64,
    pub mem_allocatable_bytes: i64,
}

/// Sum the cluster's allocatable CPU/MEM from its Node objects. Best-effort: a
/// node with no allocatable is skipped, and a list failure propagates (the
/// overview degrades to requests-only, never blanks, if this errors).
pub async fn cluster_overview(client: Client) -> Result<ClusterOverview, kube::Error> {
    let nodes: Api<Node> = Api::all(client);
    let list = nodes.list(&ListParams::default()).await?;

    let (mut cpu, mut mem) = (0i64, 0i64);
    for n in list.items {
        if let Some(a) = n.status.as_ref().and_then(|s| s.allocatable.as_ref()) {
            cpu += a.get("cpu").map(|q| super::metrics::parse_cpu_millis(&q.0)).unwrap_or(0);
            mem += a.get("memory").map(|q| super::metrics::parse_mem_bytes(&q.0)).unwrap_or(0);
        }
    }
    Ok(ClusterOverview { cpu_allocatable_millis: cpu, mem_allocatable_bytes: mem })
}
