//! Per-kind mapping from typed Kubernetes objects to [`Row`] DTOs.
//!
//! Each `map_*` function produces cells in the exact column order declared for its
//! kind in src/lib/kinds.ts (the shared column contract). Coloring (tone) follows
//! the prototype's rules: healthy → Good (green, with a status dot), degraded →
//! Warn (amber), failed → Bad (red); names Primary, namespace/age Muted, data
//! Secondary. CPU/MEM for pods and CPU/MEMORY for nodes are "—" placeholders that
//! the frontend overlays from the separate metrics feed.

use super::dto::{Cell, PodMeta, Row, Tone};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Node, Pod, Secret, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::ResourceExt;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Stable uid: the k8s uid, or "namespace/name" when uid is absent.
fn uid_of<K: ResourceExt>(obj: &K) -> String {
    obj.uid().unwrap_or_else(|| {
        format!("{}/{}", obj.namespace().unwrap_or_default(), obj.name_any())
    })
}

/// RFC3339 creation timestamp string, or "" if unset.
fn creation_rfc3339<K: ResourceExt>(obj: &K) -> String {
    obj.creation_timestamp()
        .map(|t| t.0.to_rfc3339())
        .unwrap_or_default()
}

/// Age cell built from the object's creation timestamp (frontend formats it).
fn age_cell<K: ResourceExt>(obj: &K) -> Cell {
    let ts = creation_rfc3339(obj);
    Cell::age(if ts.is_empty() { None } else { Some(ts) })
}

/// The leading NAME cell (primary tone).
fn name_cell<K: ResourceExt>(obj: &K) -> Cell {
    Cell::new(obj.name_any(), Tone::Primary)
}

/// The NAMESPACE cell (muted tone).
fn ns_cell<K: ResourceExt>(obj: &K) -> Cell {
    Cell::new(obj.namespace().unwrap_or_default(), Tone::Muted)
}

/// The prototype's status-word → tone mapping.
pub fn status_tone(status: &str) -> Tone {
    match status {
        "Running" | "Ready" | "Active" | "Completed" | "Succeeded" | "Bound" => Tone::Good,
        "Pending" | "ContainerCreating" | "Terminating" => Tone::Warn,
        _ => Tone::Bad,
    }
}

/// Humanize a duration in seconds like kubectl ages/durations ("42s", "3m12s",
/// "2h14m", "4d2h", "31d"). Mirrors the TS `formatAge` so both sides agree.
pub fn humanize_duration(mut secs: i64) -> String {
    if secs < 0 {
        secs = 0;
    }
    const MIN: i64 = 60;
    const HOUR: i64 = 3600;
    const DAY: i64 = 86400;
    if secs < MIN {
        return format!("{secs}s");
    }
    if secs < HOUR {
        let m = secs / MIN;
        let s = secs % MIN;
        return if m < 10 && s > 0 { format!("{m}m{s}s") } else { format!("{m}m") };
    }
    if secs < DAY {
        let h = secs / HOUR;
        let m = (secs % HOUR) / MIN;
        return if m > 0 { format!("{h}h{m}m") } else { format!("{h}h") };
    }
    let d = secs / DAY;
    if d < 8 {
        let h = (secs % DAY) / HOUR;
        return if h > 0 { format!("{d}d{h}h") } else { format!("{d}d") };
    }
    format!("{d}d")
}

/// Seconds between an RFC3339-ish k8s `Time` and now (clamped at 0).
fn secs_since(t: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Time) -> i64 {
    (chrono::Utc::now() - t.0).num_seconds().max(0)
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

/// Pods: NAME, NAMESPACE, READY, RESTARTS, CPU, MEM, AGE, STATUS.
pub fn map_pod(pod: &Pod) -> Row {
    let status = pod_status(pod);
    let tone = status_tone(&status);
    let (ready_str, ready_degraded) = pod_ready(pod);
    let restarts = pod_restarts(pod);

    let containers: Vec<String> = pod
        .spec
        .as_ref()
        .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
        .unwrap_or_default();
    let node = pod
        .spec
        .as_ref()
        .and_then(|s| s.node_name.clone())
        .unwrap_or_else(|| "—".into());

    let cells = vec![
        name_cell(pod),
        ns_cell(pod),
        Cell::new(&ready_str, if ready_degraded { Tone::Warn } else { Tone::Secondary }),
        Cell::new(restarts.to_string(), if restarts > 5 { Tone::Bad } else { Tone::Secondary }),
        // CPU / MEM are overlaid from the metrics feed on the frontend.
        Cell::new("—", Tone::Secondary),
        Cell::new("—", Tone::Secondary),
        age_cell(pod),
        Cell::status(&status, tone),
    ];

    Row {
        uid: uid_of(pod),
        name: pod.name_any(),
        namespace: pod.namespace(),
        cells,
        pod: Some(PodMeta {
            node,
            containers,
            status,
            ready: ready_str,
            restarts,
            creation_ts: creation_rfc3339(pod),
            status_tone: tone,
        }),
    }
}

/// Derive a kubectl-like status word for a pod: a container's waiting/terminated
/// reason (e.g. CrashLoopBackOff) takes precedence over the phase.
fn pod_status(pod: &Pod) -> String {
    let phase = pod
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".into());

    if let Some(st) = &pod.status {
        // A pod-level reason (e.g. "Evicted") overrides the phase.
        if let Some(reason) = &st.reason {
            if !reason.is_empty() {
                return reason.clone();
            }
        }
        // The first container that is waiting/terminated with a non-normal reason
        // determines the displayed status (CrashLoopBackOff, ImagePullBackOff, …).
        for cs in st.container_statuses.iter().flatten() {
            if let Some(state) = &cs.state {
                if let Some(w) = &state.waiting {
                    if let Some(r) = &w.reason {
                        if !r.is_empty() {
                            return r.clone();
                        }
                    }
                }
                if let Some(t) = &state.terminated {
                    if let Some(r) = &t.reason {
                        if !r.is_empty() && r != "Completed" {
                            return r.clone();
                        }
                    }
                }
            }
        }
    }
    phase
}

/// "readyCount/total" plus whether it's degraded (not all ready).
fn pod_ready(pod: &Pod) -> (String, bool) {
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref());
    let total = pod
        .spec
        .as_ref()
        .map(|s| s.containers.len())
        .unwrap_or(0);
    let ready = statuses
        .map(|cs| cs.iter().filter(|c| c.ready).count())
        .unwrap_or(0);
    (format!("{ready}/{total}"), ready != total || total == 0)
}

/// Total restart count across the pod's containers.
fn pod_restarts(pod: &Pod) -> i32 {
    pod.status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .map(|cs| cs.iter().map(|c| c.restart_count).sum())
        .unwrap_or(0)
}

/// Deployments: NAME, NAMESPACE, READY, UP-TO-DATE, AVAILABLE, AGE.
pub fn map_deployment(d: &Deployment) -> Row {
    let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let status = d.status.as_ref();
    let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
    let updated = status.and_then(|s| s.updated_replicas).unwrap_or(0);
    let available = status.and_then(|s| s.available_replicas).unwrap_or(0);
    let degraded = ready != desired;

    let cells = vec![
        name_cell(d),
        ns_cell(d),
        Cell::new(format!("{ready}/{desired}"), if degraded { Tone::Warn } else { Tone::Secondary }),
        Cell::new(updated.to_string(), Tone::Secondary),
        Cell::new(available.to_string(), if available == 0 && desired > 0 { Tone::Warn } else { Tone::Secondary }),
        age_cell(d),
    ];
    simple_row(d, cells)
}

/// StatefulSets: NAME, NAMESPACE, READY, AGE.
pub fn map_statefulset(s: &StatefulSet) -> Row {
    let desired = s.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
    let ready = s.status.as_ref().and_then(|st| st.ready_replicas).unwrap_or(0);
    let cells = vec![
        name_cell(s),
        ns_cell(s),
        Cell::new(format!("{ready}/{desired}"), if ready != desired { Tone::Warn } else { Tone::Secondary }),
        age_cell(s),
    ];
    simple_row(s, cells)
}

/// DaemonSets: NAME, NAMESPACE, DESIRED, READY, AGE.
pub fn map_daemonset(ds: &DaemonSet) -> Row {
    let st = ds.status.as_ref();
    let desired = st.map(|s| s.desired_number_scheduled).unwrap_or(0);
    let ready = st.map(|s| s.number_ready).unwrap_or(0);
    let cells = vec![
        name_cell(ds),
        ns_cell(ds),
        Cell::new(desired.to_string(), Tone::Secondary),
        Cell::new(ready.to_string(), if ready != desired { Tone::Warn } else { Tone::Secondary }),
        age_cell(ds),
    ];
    simple_row(ds, cells)
}

/// Jobs: NAME, NAMESPACE, COMPLETIONS, DURATION, AGE.
pub fn map_job(j: &Job) -> Row {
    let completions = j.spec.as_ref().and_then(|s| s.completions).unwrap_or(1);
    let succeeded = j.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0);
    // Duration = completion - start (if both known), else "—".
    let duration = match j.status.as_ref() {
        Some(st) => match (&st.start_time, &st.completion_time) {
            (Some(start), Some(end)) => {
                humanize_duration((end.0 - start.0).num_seconds().max(0))
            }
            _ => "—".to_string(),
        },
        None => "—".to_string(),
    };
    let complete = succeeded >= completions;
    let cells = vec![
        name_cell(j),
        ns_cell(j),
        Cell::new(format!("{succeeded}/{completions}"), if complete { Tone::Secondary } else { Tone::Warn }),
        Cell::new(duration, Tone::Secondary),
        age_cell(j),
    ];
    simple_row(j, cells)
}

/// CronJobs: NAME, NAMESPACE, SCHEDULE, LAST RUN, AGE.
pub fn map_cronjob(c: &CronJob) -> Row {
    let schedule = c.spec.as_ref().map(|s| s.schedule.clone()).unwrap_or_default();
    let last_run = c
        .status
        .as_ref()
        .and_then(|s| s.last_schedule_time.as_ref())
        .map(|t| format!("{} ago", humanize_duration(secs_since(t))))
        .unwrap_or_else(|| "—".into());
    let cells = vec![
        name_cell(c),
        ns_cell(c),
        Cell::new(schedule, Tone::Secondary),
        Cell::new(last_run, Tone::Secondary),
        age_cell(c),
    ];
    simple_row(c, cells)
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/// Services: NAME, NAMESPACE, TYPE, CLUSTER-IP, PORTS, AGE.
pub fn map_service(svc: &Service) -> Row {
    let spec = svc.spec.as_ref();
    let ty = spec.and_then(|s| s.type_.clone()).unwrap_or_else(|| "ClusterIP".into());
    let cluster_ip = spec.and_then(|s| s.cluster_ip.clone()).unwrap_or_else(|| "None".into());
    // "8080/TCP, 443/TCP" from the port list.
    let ports = spec
        .and_then(|s| s.ports.as_ref())
        .map(|ps| {
            ps.iter()
                .map(|p| format!("{}/{}", p.port, p.protocol.clone().unwrap_or_else(|| "TCP".into())))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let cells = vec![
        name_cell(svc),
        ns_cell(svc),
        Cell::new(ty, Tone::Secondary),
        Cell::new(cluster_ip, Tone::Secondary),
        Cell::new(ports, Tone::Secondary),
        age_cell(svc),
    ];
    simple_row(svc, cells)
}

/// Ingresses: NAME, NAMESPACE, HOSTS, CLASS, AGE.
pub fn map_ingress(ing: &Ingress) -> Row {
    let spec = ing.spec.as_ref();
    let hosts = spec
        .and_then(|s| s.rules.as_ref())
        .map(|rs| {
            rs.iter()
                .filter_map(|r| r.host.clone())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let class = spec
        .and_then(|s| s.ingress_class_name.clone())
        .unwrap_or_else(|| "—".into());
    let cells = vec![
        name_cell(ing),
        ns_cell(ing),
        Cell::new(hosts, Tone::Secondary),
        Cell::new(class, Tone::Secondary),
        age_cell(ing),
    ];
    simple_row(ing, cells)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// ConfigMaps: NAME, NAMESPACE, DATA, AGE.
pub fn map_configmap(cm: &ConfigMap) -> Row {
    let data = cm.data.as_ref().map(|d| d.len()).unwrap_or(0)
        + cm.binary_data.as_ref().map(|d| d.len()).unwrap_or(0);
    let cells = vec![
        name_cell(cm),
        ns_cell(cm),
        Cell::new(data.to_string(), Tone::Secondary),
        age_cell(cm),
    ];
    simple_row(cm, cells)
}

/// Secrets: NAME, NAMESPACE, TYPE, DATA, AGE. (Values are never surfaced.)
pub fn map_secret(sec: &Secret) -> Row {
    let ty = sec.type_.clone().unwrap_or_else(|| "Opaque".into());
    let data = sec.data.as_ref().map(|d| d.len()).unwrap_or(0)
        + sec.string_data.as_ref().map(|d| d.len()).unwrap_or(0);
    let cells = vec![
        name_cell(sec),
        ns_cell(sec),
        Cell::new(ty, Tone::Secondary),
        Cell::new(data.to_string(), Tone::Secondary),
        age_cell(sec),
    ];
    simple_row(sec, cells)
}

// ---------------------------------------------------------------------------
// Cluster-scoped
// ---------------------------------------------------------------------------

/// Nodes: NAME, STATUS, ROLES, CPU, MEMORY, VERSION. (No namespace column.)
/// CPU/MEMORY are "—" placeholders overlaid from the node metrics feed.
pub fn map_node(node: &Node) -> Row {
    let ready = node
        .status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| {
            cs.iter()
                .any(|c| c.type_ == "Ready" && c.status == "True")
        })
        .unwrap_or(false);
    let (status_text, status_tone) = if ready {
        ("Ready", Tone::Good)
    } else {
        ("NotReady", Tone::Bad)
    };

    // Roles come from "node-role.kubernetes.io/<role>" labels.
    let roles = node
        .labels()
        .keys()
        .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
        .filter(|r| !r.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    let roles = if roles.is_empty() { "<none>".to_string() } else { roles };

    let version = node
        .status
        .as_ref()
        .map(|s| s.node_info.as_ref().map(|i| i.kubelet_version.clone()).unwrap_or_default())
        .unwrap_or_default();

    let cells = vec![
        name_cell(node),
        Cell::status(status_text, status_tone),
        Cell::new(roles, Tone::Secondary),
        Cell::new("—", Tone::Secondary), // CPU % (overlaid)
        Cell::new("—", Tone::Secondary), // MEMORY % (overlaid)
        Cell::new(version, Tone::Secondary),
    ];
    Row {
        uid: uid_of(node),
        name: node.name_any(),
        namespace: None,
        cells,
        pod: None,
    }
}

/// Namespaces: NAME, STATUS, PODS, AGE. (No namespace column.)
/// PODS is "—": a per-namespace pod count would require a cross-watcher join,
/// deferred as a follow-up.
pub fn map_namespace(ns: &Namespace) -> Row {
    let phase = ns
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Active".into());
    let tone = status_tone(&phase);
    let cells = vec![
        name_cell(ns),
        Cell::status(&phase, tone),
        Cell::new("—", Tone::Secondary),
        age_cell(ns),
    ];
    Row {
        uid: uid_of(ns),
        name: ns.name_any(),
        namespace: None,
        cells,
        pod: None,
    }
}

// ---------------------------------------------------------------------------
// Events (cluster-wide feed, B14)
// ---------------------------------------------------------------------------

/// Events: TYPE, REASON, OBJECT, NAMESPACE, AGE, COUNT, MESSAGE.
///
/// The AGE cell carries a last-seen epoch as its sort key, which the watcher's
/// post-processing uses to order the feed (Warnings first, then newest).
pub fn map_event(e: &k8s_openapi::api::core::v1::Event) -> Row {
    let type_ = e.type_.clone().unwrap_or_else(|| "Normal".into());
    // Warning is the only tone that should draw the eye; Normal reads green.
    let tone = if type_ == "Warning" { Tone::Bad } else { Tone::Good };

    let last = event_last_seen(e);
    let object = format!(
        "{}/{}",
        e.involved_object.kind.clone().unwrap_or_default(),
        e.involved_object.name.clone().unwrap_or_default()
    );

    let cells = vec![
        Cell::new(&type_, tone),
        Cell::new(e.reason.clone().unwrap_or_default(), Tone::Primary),
        Cell::new(object, Tone::Secondary),
        Cell::new(e.namespace().unwrap_or_default(), Tone::Muted),
        // Age from last-seen (not creation): events repeat and update lastTimestamp.
        Cell::age(Some(last.to_rfc3339())).with_sort(last.timestamp_millis() as f64),
        Cell::new(format!("×{}", e.count.unwrap_or(1)), Tone::Secondary),
        Cell::new(e.message.clone().unwrap_or_default(), Tone::Secondary),
    ];

    Row {
        uid: uid_of(e),
        name: e.name_any(),
        namespace: e.namespace(),
        cells,
        pod: None,
    }
}

/// Best "last seen" time for an event: lastTimestamp, else eventTime, else creation.
fn event_last_seen(e: &k8s_openapi::api::core::v1::Event) -> chrono::DateTime<chrono::Utc> {
    if let Some(t) = &e.last_timestamp {
        return t.0;
    }
    if let Some(t) = &e.event_time {
        return t.0;
    }
    e.creation_timestamp()
        .map(|t| t.0)
        .unwrap_or_else(chrono::Utc::now)
}

/// Order the events feed: Warnings first, then most-recent first, capped.
/// Applied to the whole snapshot by the events watcher before emitting.
pub fn sort_events(mut rows: Vec<Row>, cap: usize) -> Vec<Row> {
    rows.sort_by(|a, b| {
        let warn = |r: &Row| r.cells.first().map(|c| c.text == "Warning").unwrap_or(false);
        let seen = |r: &Row| r.cells.get(4).and_then(|c| c.sort).unwrap_or(0.0);
        // Warnings before Normals, then newest first.
        warn(b)
            .cmp(&warn(a))
            .then(seen(b).partial_cmp(&seen(a)).unwrap_or(std::cmp::Ordering::Equal))
    });
    rows.truncate(cap);
    rows
}

// ---------------------------------------------------------------------------
// Custom / CRD-backed kinds (B15)
// ---------------------------------------------------------------------------

/// Generic columns for a CRD-backed object: NAME, NAMESPACE (namespaced kinds
/// only), AGE.
///
/// A CRD's schema is arbitrary, so there is no meaningful status or ready column
/// to derive without per-CRD knowledge; the YAML tab is where the detail lives.
/// The column set must match `kinds.ts`'s generic custom columns.
pub fn map_dynamic(o: &kube::core::DynamicObject, namespaced: bool) -> Row {
    let mut cells = vec![Cell::new(o.name_any(), Tone::Primary)];
    if namespaced {
        cells.push(Cell::new(o.namespace().unwrap_or_default(), Tone::Muted));
    }
    cells.push(Cell::age(o.creation_timestamp().map(|t| t.0.to_rfc3339())));

    Row {
        uid: uid_of(o),
        name: o.name_any(),
        namespace: o.namespace(),
        cells,
        pod: None,
    }
}

/// Build a namespaced Row from prebuilt cells (shared by the simple kinds).
fn simple_row<K: ResourceExt>(obj: &K, cells: Vec<Cell>) -> Row {
    Row {
        uid: uid_of(obj),
        name: obj.name_any(),
        namespace: obj.namespace(),
        cells,
        pod: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A healthy Running pod: status Good with a dot, ready/restarts Secondary.
    #[test]
    fn healthy_running_pod() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "ok-pod", "namespace": "prod", "uid": "u1",
                          "creationTimestamp": "2026-07-01T00:00:00Z" },
            "spec": { "nodeName": "n1", "containers": [{ "name": "app" }, { "name": "side" }] },
            "status": { "phase": "Running", "containerStatuses": [
                { "name": "app", "ready": true, "restartCount": 0, "image": "i", "imageID": "d", "state": { "running": {} } },
                { "name": "side", "ready": true, "restartCount": 0, "image": "i", "imageID": "d", "state": { "running": {} } }
            ]}
        })).unwrap();
        let row = map_pod(&pod);
        // Columns: NAME,NAMESPACE,READY,RESTARTS,CPU,MEM,AGE,STATUS
        assert_eq!(row.cells[2].tone, Tone::Secondary, "2/2 ready is not degraded");
        assert_eq!(row.cells[3].tone, Tone::Secondary, "0 restarts");
        assert_eq!(row.cells[7].tone, Tone::Good);
        assert!(row.cells[7].dot, "status cell has a leading dot");
        assert_eq!(row.pod.as_ref().unwrap().status, "Running");
    }

    /// CrashLoopBackOff: status Bad, degraded ready Warn, high restarts Bad.
    #[test]
    fn crashloop_pod() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "crash", "namespace": "prod", "uid": "u2",
                          "creationTimestamp": "2026-07-15T09:00:00Z" },
            "spec": { "nodeName": "n2", "containers": [{ "name": "auth" }, { "name": "side" }] },
            "status": { "phase": "Running", "containerStatuses": [
                { "name": "auth", "ready": false, "restartCount": 14, "image": "i", "imageID": "d",
                  "state": { "waiting": { "reason": "CrashLoopBackOff" } } },
                { "name": "side", "ready": true, "restartCount": 0, "image": "i", "imageID": "d", "state": { "running": {} } }
            ]}
        })).unwrap();
        let row = map_pod(&pod);
        assert_eq!(row.cells[2].text, "1/2");
        assert_eq!(row.cells[2].tone, Tone::Warn, "1/2 ready is degraded");
        assert_eq!(row.cells[3].text, "14");
        assert_eq!(row.cells[3].tone, Tone::Bad, "restarts > 5");
        assert_eq!(row.cells[7].text, "CrashLoopBackOff");
        assert_eq!(row.cells[7].tone, Tone::Bad);
    }

    /// Pending pod: status Warn, CPU/MEM em-dash placeholders.
    #[test]
    fn pending_pod() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "canary", "namespace": "staging", "uid": "u3",
                          "creationTimestamp": "2026-07-15T11:59:00Z" },
            "spec": { "containers": [{ "name": "a" }, { "name": "b" }, { "name": "c" }] },
            "status": { "phase": "Pending" }
        })).unwrap();
        let row = map_pod(&pod);
        assert_eq!(row.cells[2].text, "0/3");
        assert_eq!(row.cells[2].tone, Tone::Warn);
        assert_eq!(row.cells[4].text, "—", "CPU is a placeholder");
        assert_eq!(row.cells[5].text, "—", "MEM is a placeholder");
        assert_eq!(row.cells[7].tone, Tone::Warn);
    }

    /// A degraded Deployment (0/1) colors the READY cell amber.
    #[test]
    fn degraded_deployment() {
        let dep: Deployment = serde_json::from_value(json!({
            "metadata": { "name": "heimdall", "namespace": "prod", "uid": "d1",
                          "creationTimestamp": "2026-07-15T09:45:00Z" },
            "spec": { "replicas": 1 },
            "status": { "readyReplicas": 0, "updatedReplicas": 1, "availableReplicas": 0 }
        })).unwrap();
        let row = map_deployment(&dep);
        // Columns: NAME,NAMESPACE,READY,UP-TO-DATE,AVAILABLE,AGE
        assert_eq!(row.cells[2].text, "0/1");
        assert_eq!(row.cells[2].tone, Tone::Warn);
        assert_eq!(row.cells[4].tone, Tone::Warn, "0 available with desired>0");
    }

    /// A Ready node shows a green status cell with a dot.
    #[test]
    fn ready_node() {
        let node: Node = serde_json::from_value(json!({
            "metadata": { "name": "n1", "uid": "nn1",
                          "labels": { "node-role.kubernetes.io/worker": "" } },
            "status": {
                "conditions": [{ "type": "Ready", "status": "True" }],
                "nodeInfo": { "kubeletVersion": "v1.31.2",
                    "machineID":"","systemUUID":"","bootID":"","kernelVersion":"",
                    "osImage":"","containerRuntimeVersion":"","kubeProxyVersion":"",
                    "operatingSystem":"linux","architecture":"arm64" }
            }
        })).unwrap();
        let row = map_node(&node);
        // Columns: NAME,STATUS,ROLES,CPU,MEMORY,VERSION (no namespace)
        assert_eq!(row.namespace, None);
        assert_eq!(row.cells[1].text, "Ready");
        assert_eq!(row.cells[1].tone, Tone::Good);
        assert!(row.cells[1].dot);
        assert_eq!(row.cells[2].text, "worker");
        assert_eq!(row.cells[5].text, "v1.31.2");
    }

    // ---- Events feed (B14) ----

    /// Build an Event with a given type/reason and last-seen time.
    fn event(type_: &str, reason: &str, last: &str) -> k8s_openapi::api::core::v1::Event {
        serde_json::from_value(json!({
            "metadata": { "name": format!("obj.{reason}"), "namespace": "prod", "uid": reason },
            "type": type_,
            "reason": reason,
            "count": 3,
            "message": "something happened",
            "lastTimestamp": last,
            "involvedObject": { "kind": "Pod", "name": "my-pod", "namespace": "prod" },
        }))
        .unwrap()
    }

    /// Columns TYPE, REASON, OBJECT, NAMESPACE, AGE, COUNT, MESSAGE; Warning tones red.
    #[test]
    fn warning_event_columns() {
        let row = map_event(&event("Warning", "FailedMount", "2026-07-16T09:00:00Z"));
        assert_eq!(row.cells[0].text, "Warning");
        assert_eq!(row.cells[0].tone, Tone::Bad);
        assert_eq!(row.cells[1].text, "FailedMount");
        assert_eq!(row.cells[2].text, "Pod/my-pod", "OBJECT is kind/name");
        assert_eq!(row.cells[3].text, "prod");
        assert_eq!(row.cells[4].format, Some("age"), "AGE is formatted by the frontend");
        assert!(row.cells[4].sort.is_some(), "AGE carries the last-seen sort key");
        assert_eq!(row.cells[5].text, "×3");
    }

    /// Normal events read green.
    #[test]
    fn normal_event_tone() {
        let row = map_event(&event("Normal", "Pulled", "2026-07-16T09:00:00Z"));
        assert_eq!(row.cells[0].tone, Tone::Good);
    }

    /// The feed puts every Warning above every Normal, and newest first within each.
    #[test]
    fn feed_orders_warnings_then_newest() {
        let rows = vec![
            map_event(&event("Normal", "NewNormal", "2026-07-16T09:00:00Z")),
            map_event(&event("Warning", "OldWarn", "2026-07-16T08:00:00Z")),
            map_event(&event("Normal", "OldNormal", "2026-07-16T07:00:00Z")),
            map_event(&event("Warning", "NewWarn", "2026-07-16T08:30:00Z")),
        ];
        let sorted = sort_events(rows, 500);
        let reasons: Vec<&str> = sorted.iter().map(|r| r.cells[1].text.as_str()).collect();
        assert_eq!(reasons, ["NewWarn", "OldWarn", "NewNormal", "OldNormal"]);
    }

    /// The cap bounds the payload, keeping the highest-priority rows.
    #[test]
    fn feed_truncates_to_cap() {
        let rows = vec![
            map_event(&event("Warning", "Keep", "2026-07-16T09:00:00Z")),
            map_event(&event("Normal", "Drop", "2026-07-16T08:00:00Z")),
        ];
        let sorted = sort_events(rows, 1);
        assert_eq!(sorted.len(), 1);
        assert_eq!(sorted[0].cells[1].text, "Keep");
    }

    /// lastTimestamp is preferred, but events that only carry eventTime still sort.
    #[test]
    fn event_time_fallback() {
        let e: k8s_openapi::api::core::v1::Event = serde_json::from_value(json!({
            "metadata": { "name": "e", "namespace": "prod", "uid": "u" },
            "type": "Normal",
            "reason": "Started",
            "eventTime": "2026-07-16T09:00:00.000000Z",
            "involvedObject": { "kind": "Pod", "name": "p" },
        }))
        .unwrap();
        let row = map_event(&e);
        assert!(row.cells[4].sort.is_some());
        assert_eq!(row.cells[5].text, "×1", "missing count defaults to 1");
    }
}
