//! Metrics and cluster-status pollers.
//!
//! Two tasks run per connection:
//!   - metrics poller (~15s): pod + node usage from `metrics.k8s.io`, emitting
//!     `pod-metrics` / `node-metrics`. If the metrics API is absent it stops
//!     emitting (UI shows "—") but keeps probing occasionally.
//!   - status poller (~10s): server version, API latency (timed `/version`), nodes
//!     ready, and cluster CPU/MEM %, emitting `cluster-status`.
//!
//! The two share the latest cluster CPU/MEM % via a small mutex so the status
//! event can include them without re-fetching.

use super::{events, ClientManager, Cid};
use crate::error::{AppError, ErrorEnvelope};
use k8s_openapi::api::core::v1::Node;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, Runtime};
use tokio::sync::Mutex;
use tokio::time::{interval, Duration, Instant};

/// Default poll intervals. Both are user-configurable (B23); these are the
/// values used when nothing has been saved.
pub const METRICS_INTERVAL: Duration = Duration::from_secs(15);
pub const STATUS_INTERVAL: Duration = Duration::from_secs(10);

/// How often the pollers run. Read from prefs on connect (B23), so a change
/// takes effect the next time a connection is established.
#[derive(Clone, Copy)]
pub struct PollIntervals {
    pub metrics: Duration,
    pub status: Duration,
}

impl Default for PollIntervals {
    fn default() -> Self {
        PollIntervals { metrics: METRICS_INTERVAL, status: STATUS_INTERVAL }
    }
}

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

/// Per-pod usage keyed by "ns/name".
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PodUsage {
    cpu_millis: i64,
    mem_bytes: i64,
}

/// Per-node usage percentages keyed by node name.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NodeUsage {
    cpu_percent: f64,
    mem_percent: f64,
}

/// Cluster-wide status for the status bar / switcher. Fields are `pub(crate)`
/// so the `retry_cluster` command can build a retry payload on the cached one.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClusterStatusPayload {
    pub(crate) connected: bool,
    pub(crate) version: String,
    pub(crate) api_latency_ms: u64,
    pub(crate) nodes_ready: i32,
    pub(crate) nodes_total: i32,
    /// null (None) when metrics are unavailable.
    pub(crate) cpu_percent: Option<f64>,
    pub(crate) mem_percent: Option<f64>,
    /// True when the cluster was connected but its API has stopped answering
    /// (B74-L). The UI shows "stale" — rows are retained with an age, and this
    /// clears automatically when the next probe succeeds. Distinct from a failed
    /// connect: the connection isn't torn down, nothing is dropped.
    pub(crate) stale: bool,
    /// Unix millis of the last successful probe — the age shown on stale rows.
    pub(crate) last_seen_ms: u64,
    /// The classified probe failure, when stale.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ErrorEnvelope>,
}

// ---------------------------------------------------------------------------
// Raw metrics.k8s.io response types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MetricsList<T> {
    items: Vec<T>,
}
#[derive(Deserialize)]
struct MetaName {
    name: String,
    #[serde(default)]
    namespace: String,
}
#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    cpu: String,
    #[serde(default)]
    memory: String,
}
#[derive(Deserialize)]
struct PodMetric {
    metadata: MetaName,
    containers: Vec<ContainerUsage>,
}
#[derive(Deserialize)]
struct ContainerUsage {
    usage: Usage,
}
#[derive(Deserialize)]
struct NodeMetric {
    metadata: MetaName,
    usage: Usage,
}

/// Shared latest cluster CPU/MEM % (produced by the metrics task, read by status).
type SharedClusterPct = Arc<Mutex<Option<(f64, f64)>>>;

/// Spawn the metrics + status pollers, returning their join handles for the
/// manager to register (and abort on disconnect).
pub fn spawn_pollers<R: Runtime>(
    mgr: Arc<ClientManager<R>>,
    cid: Cid,
    client: Client,
    intervals: PollIntervals,
) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
    let shared: SharedClusterPct = Arc::new(Mutex::new(None));

    let metrics_task = tokio::spawn(metrics_loop(
        mgr.clone(),
        cid.clone(),
        client.clone(),
        shared.clone(),
        intervals.metrics,
    ));
    let status_task = tokio::spawn(status_loop(mgr, cid, client, shared, intervals.status));
    (metrics_task, status_task)
}

/// Poll pod/node metrics on an interval; emit events; track availability.
async fn metrics_loop<R: Runtime>(
    mgr: Arc<ClientManager<R>>,
    cid: Cid,
    client: Client,
    shared: SharedClusterPct,
    every: Duration,
) {
    let mut tick = interval(every);
    // When the metrics API is missing we back off probing to ~60s.
    let mut miss_streak = 0u32;

    loop {
        tick.tick().await;

        // Skip most attempts while the API is known-absent (probe every ~4th tick).
        if miss_streak > 0 && miss_streak % 4 != 0 {
            miss_streak += 1;
            continue;
        }

        let pods = fetch_pod_metrics(&client).await;
        let nodes = fetch_node_metrics(&client).await;

        match (pods, nodes) {
            (Ok(pod_map), Ok((node_map, cluster_pct))) => {
                miss_streak = 0;
                let app = mgr.app();
                let _ = app.emit(&events::channel(events::POD_METRICS, &cid), &pod_map);
                let _ = app.emit(&events::channel(events::NODE_METRICS, &cid), &node_map);
                *shared.lock().await = Some(cluster_pct);
            }
            _ => {
                // metrics-server absent or erroring: stop feeding stale values.
                if miss_streak == 0 {
                    tracing::warn!("metrics.k8s.io unavailable; CPU/MEM will show as —");
                }
                miss_streak += 1;
                *shared.lock().await = None;
            }
        }
    }
}

/// Fetch pod metrics and reduce to a "ns/name" → usage map (summing containers).
async fn fetch_pod_metrics(client: &Client) -> Result<HashMap<String, PodUsage>, kube::Error> {
    let req = http::Request::get("/apis/metrics.k8s.io/v1beta1/pods")
        .body(Vec::new())
        .map_err(|e| kube::Error::Service(Box::new(e)))?;
    let list: MetricsList<PodMetric> = client.request(req).await?;

    let mut map = HashMap::new();
    for pm in list.items {
        let cpu: i64 = pm.containers.iter().map(|c| parse_cpu_millis(&c.usage.cpu)).sum();
        let mem: i64 = pm.containers.iter().map(|c| parse_mem_bytes(&c.usage.memory)).sum();
        let key = format!("{}/{}", pm.metadata.namespace, pm.metadata.name);
        map.insert(key, PodUsage { cpu_millis: cpu, mem_bytes: mem });
    }
    Ok(map)
}

/// Fetch node metrics + allocatable and compute per-node and cluster-wide %.
async fn fetch_node_metrics(
    client: &Client,
) -> Result<(HashMap<String, NodeUsage>, (f64, f64)), kube::Error> {
    // Usage from metrics.k8s.io.
    let req = http::Request::get("/apis/metrics.k8s.io/v1beta1/nodes")
        .body(Vec::new())
        .map_err(|e| kube::Error::Service(Box::new(e)))?;
    let list: MetricsList<NodeMetric> = client.request(req).await?;

    // Allocatable capacity from the Node objects.
    let nodes: Api<Node> = Api::all(client.clone());
    let node_objs = nodes.list(&ListParams::default()).await?;

    let mut alloc: HashMap<String, (i64, i64)> = HashMap::new();
    for n in node_objs.items {
        let name = n.metadata.name.clone().unwrap_or_default();
        if let Some(status) = &n.status {
            if let Some(a) = &status.allocatable {
                let cpu = a.get("cpu").map(|q| parse_cpu_millis(&q.0)).unwrap_or(0);
                let mem = a.get("memory").map(|q| parse_mem_bytes(&q.0)).unwrap_or(0);
                alloc.insert(name, (cpu, mem));
            }
        }
    }

    let mut map = HashMap::new();
    let (mut used_cpu, mut used_mem, mut cap_cpu, mut cap_mem) = (0i64, 0i64, 0i64, 0i64);
    for nm in list.items {
        let name = nm.metadata.name;
        let cpu = parse_cpu_millis(&nm.usage.cpu);
        let mem = parse_mem_bytes(&nm.usage.memory);
        let (acpu, amem) = alloc.get(&name).copied().unwrap_or((0, 0));
        map.insert(
            name,
            NodeUsage {
                cpu_percent: pct(cpu, acpu),
                mem_percent: pct(mem, amem),
            },
        );
        used_cpu += cpu;
        used_mem += mem;
        cap_cpu += acpu;
        cap_mem += amem;
    }

    Ok((map, (pct(used_cpu, cap_cpu), pct(used_mem, cap_mem))))
}

/// Poll cluster status on an interval: version, latency, nodes ready, cpu/mem %.
/// A failed probe marks the cluster *stale* (B74-L) rather than dropping the
/// connection — the next successful probe clears it automatically.
async fn status_loop<R: Runtime>(
    mgr: Arc<ClientManager<R>>,
    cid: Cid,
    client: Client,
    shared: SharedClusterPct,
    every: Duration,
) {
    let mut tick = interval(every);
    // The age shown while stale is the last *successful* probe; it must survive
    // failures, so it's threaded through the loop rather than recomputed.
    let mut last_ok_ms = 0u64;
    loop {
        tick.tick().await;
        let payload = probe_status(&client, &shared, &mut last_ok_ms).await;
        mgr.emit_status(&cid, payload).await;
    }
}

/// One status probe: version + latency (the reachability check), node readiness,
/// and the shared CPU/MEM %. On a failed probe the cluster is marked stale with
/// the classified error, retaining whatever rows the UI already has. `last_ok_ms`
/// is the previous successful probe; a success replaces it with now.
pub(crate) async fn probe_status(
    client: &Client,
    shared: &SharedClusterPct,
    last_ok_ms: &mut u64,
) -> ClusterStatusPayload {
    // Timed version probe doubles as the reachability + latency check.
    let start = Instant::now();
    let version_res = client.apiserver_version().await;
    let latency = start.elapsed().as_millis() as u64;

    let (connected, version, stale, error) = match version_res {
        Ok(info) => {
            *last_ok_ms = now_ms();
            (true, info.git_version, false, None)
        }
        Err(e) => {
            tracing::warn!("cluster status probe failed: {e}");
            (
                false,
                String::new(),
                true,
                Some(AppError::envelope_for_code(
                    crate::error::ErrorCode::Unreachable,
                    e.to_string(),
                    None,
                )),
            )
        }
    };

    // Node readiness (best-effort; 0/0 if the list fails).
    let (ready, total) = if connected {
        count_ready_nodes(client).await
    } else {
        (0, 0)
    };

    let (cpu, mem) = match *shared.lock().await {
        Some((c, m)) => (Some(round1(c)), Some(round1(m))),
        None => (None, None),
    };

    ClusterStatusPayload {
        connected,
        version,
        api_latency_ms: latency,
        nodes_ready: ready,
        nodes_total: total,
        cpu_percent: cpu,
        mem_percent: mem,
        stale,
        // 0 until the first successful probe; afterwards the last good one.
        last_seen_ms: *last_ok_ms,
        error,
    }
}

/// Current unix time in milliseconds.
fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Count Ready nodes / total nodes.
async fn count_ready_nodes(client: &Client) -> (i32, i32) {
    let nodes: Api<Node> = Api::all(client.clone());
    match nodes.list(&ListParams::default()).await {
        Ok(list) => {
            let total = list.items.len() as i32;
            let ready = list
                .items
                .iter()
                .filter(|n| {
                    n.status
                        .as_ref()
                        .and_then(|s| s.conditions.as_ref())
                        .map(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
                        .unwrap_or(false)
                })
                .count() as i32;
            (ready, total)
        }
        Err(_) => (0, 0),
    }
}

// ---------------------------------------------------------------------------
// Quantity parsing
// ---------------------------------------------------------------------------

/// Parse a Kubernetes CPU quantity to milli-cores.
/// Handles nano ("123456n"), micro ("500u"), milli ("212m"), and cores ("2", "1.5").
pub fn parse_cpu_millis(s: &str) -> i64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    if let Some(v) = s.strip_suffix('n') {
        return (v.parse::<f64>().unwrap_or(0.0) / 1_000_000.0).round() as i64;
    }
    if let Some(v) = s.strip_suffix('u') {
        return (v.parse::<f64>().unwrap_or(0.0) / 1_000.0).round() as i64;
    }
    if let Some(v) = s.strip_suffix('m') {
        return v.parse::<f64>().unwrap_or(0.0).round() as i64;
    }
    // Bare number is in cores.
    (s.parse::<f64>().unwrap_or(0.0) * 1000.0).round() as i64
}

/// Parse a Kubernetes memory quantity to bytes.
/// Handles binary (Ki/Mi/Gi/Ti/Pi), decimal (k/M/G/T/P), and bare bytes.
pub fn parse_mem_bytes(s: &str) -> i64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    // Binary suffixes first (they end in 'i').
    const BINARY: [(&str, f64); 5] = [
        ("Ki", 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("Ti", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Pi", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
    ];
    for (suf, mult) in BINARY {
        if let Some(v) = s.strip_suffix(suf) {
            return (v.parse::<f64>().unwrap_or(0.0) * mult).round() as i64;
        }
    }
    const DECIMAL: [(&str, f64); 5] = [
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
    ];
    for (suf, mult) in DECIMAL {
        if let Some(v) = s.strip_suffix(suf) {
            return (v.parse::<f64>().unwrap_or(0.0) * mult).round() as i64;
        }
    }
    s.parse::<f64>().unwrap_or(0.0).round() as i64
}

/// Percentage used/capacity, guarding divide-by-zero.
fn pct(used: i64, cap: i64) -> f64 {
    if cap <= 0 {
        0.0
    } else {
        (used as f64 / cap as f64) * 100.0
    }
}

/// Round to one decimal place.
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_quantity_parsing() {
        assert_eq!(parse_cpu_millis("212m"), 212);
        assert_eq!(parse_cpu_millis("2"), 2000);
        assert_eq!(parse_cpu_millis("1.5"), 1500);
        assert_eq!(parse_cpu_millis("500000000n"), 500); // 0.5 cores
        assert_eq!(parse_cpu_millis("500000u"), 500);
        assert_eq!(parse_cpu_millis(""), 0);
    }

    #[test]
    fn mem_quantity_parsing() {
        assert_eq!(parse_mem_bytes("486Mi"), 486 * 1024 * 1024);
        assert_eq!(parse_mem_bytes("2Gi"), 2 * 1024 * 1024 * 1024);
        assert_eq!(parse_mem_bytes("1000k"), 1_000_000);
        assert_eq!(parse_mem_bytes("1048576"), 1_048_576);
        assert_eq!(parse_mem_bytes(""), 0);
    }

    #[test]
    fn percentage_guards_zero_capacity() {
        assert_eq!(pct(5, 0), 0.0);
        assert_eq!(pct(50, 100), 50.0);
    }
}
