//! Per-kind mapping from typed Kubernetes objects to [`Row`] DTOs.
//!
//! Each `map_*` function produces cells in the exact column order declared for its
//! kind in src/lib/kinds.ts (the shared column contract). Coloring (tone) follows
//! the prototype's rules: healthy → Good (green, with a status dot), degraded →
//! Warn (amber), failed → Bad (red); names Primary, namespace/age Muted, data
//! Secondary. CPU/MEM for pods and CPU/MEMORY for nodes are "—" placeholders that
//! the frontend overlays from the separate metrics feed.

use super::discovery::PrinterColumn;
use super::dto::{Cell, CronMeta, InvolvedRef, JobMeta, NavTarget, PodMeta, PodResources, Row, Tone};
use super::jsonpath;
use super::metrics::{parse_cpu_millis, parse_mem_bytes};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service,
    ServiceAccount,
};
use k8s_openapi::api::networking::v1::{Ingress, IngressClass};
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::api::storage::v1::StorageClass;
use kube::ResourceExt;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Stable uid: the k8s uid, or "namespace/name" when uid is absent.
pub(crate) fn uid_of<K: ResourceExt>(obj: &K) -> String {
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
            resources: pod_resources(pod),
        }),
        // Labels drive the "view pods" label-selector filter (B33).
        labels: pod.metadata.labels.clone(),
        ..Default::default()
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

/// Sum a pod's regular containers' CPU/memory requests and limits into pod totals
/// (see [`PodResources`] for the None semantics). Init containers are excluded so
/// the totals compare like-for-like against the usage the metrics feed reports.
fn pod_resources(pod: &Pod) -> PodResources {
    let containers = match pod.spec.as_ref() {
        Some(s) => &s.containers,
        None => return PodResources::default(),
    };
    if containers.is_empty() {
        return PodResources::default();
    }

    // A request total is meaningful once any container sets one; a limit total is
    // a true pod ceiling only when *every* container caps that resource, so an
    // uncapped container drops the whole limit to None.
    let (mut cpu_req, mut any_cpu_req) = (0i64, false);
    let (mut mem_req, mut any_mem_req) = (0i64, false);
    let (mut cpu_lim, mut all_cpu_lim) = (0i64, true);
    let (mut mem_lim, mut all_mem_lim) = (0i64, true);

    for ct in containers {
        let requests = ct.resources.as_ref().and_then(|r| r.requests.as_ref());
        let limits = ct.resources.as_ref().and_then(|r| r.limits.as_ref());

        if let Some(q) = requests.and_then(|m| m.get("cpu")) {
            cpu_req += parse_cpu_millis(&q.0);
            any_cpu_req = true;
        }
        if let Some(q) = requests.and_then(|m| m.get("memory")) {
            mem_req += parse_mem_bytes(&q.0);
            any_mem_req = true;
        }
        match limits.and_then(|m| m.get("cpu")) {
            Some(q) => cpu_lim += parse_cpu_millis(&q.0),
            None => all_cpu_lim = false,
        }
        match limits.and_then(|m| m.get("memory")) {
            Some(q) => mem_lim += parse_mem_bytes(&q.0),
            None => all_mem_lim = false,
        }
    }

    PodResources {
        cpu_request_millis: any_cpu_req.then_some(cpu_req),
        cpu_limit_millis: all_cpu_lim.then_some(cpu_lim),
        mem_request_bytes: any_mem_req.then_some(mem_req),
        mem_limit_bytes: all_mem_lim.then_some(mem_lim),
    }
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
    let mut row = simple_row(d, cells);
    // The pod selector powers the "view pods" jump (B33).
    row.selector = d.spec.as_ref().and_then(|s| s.selector.match_labels.clone());
    row
}

/// ReplicaSets: NAME, NAMESPACE, DESIRED, CURRENT, READY, AGE.
///
/// Listed because it's a pod's *immediate* owner and a Deployment's actual
/// generation — the object the owner chain used to have to route around.
/// A scaled-down old generation (0 desired) is normal history, not a fault, so it
/// reads muted rather than amber.
pub fn map_replicaset(rs: &ReplicaSet) -> Row {
    let desired = rs.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let status = rs.status.as_ref();
    let current = status.map(|s| s.replicas).unwrap_or(0);
    let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);

    // Desired 0 is a superseded generation sitting at rest; only a shortfall
    // against a non-zero desired is worth colouring.
    let ready_tone = if desired == 0 {
        Tone::Muted
    } else if ready != desired {
        Tone::Warn
    } else {
        Tone::Secondary
    };

    let cells = vec![
        name_cell(rs),
        ns_cell(rs),
        Cell::new(desired.to_string(), if desired == 0 { Tone::Muted } else { Tone::Secondary }),
        Cell::new(current.to_string(), Tone::Secondary),
        Cell::new(ready.to_string(), ready_tone),
        age_cell(rs),
    ];
    let mut row = simple_row(rs, cells);
    row.selector = rs.spec.as_ref().and_then(|s| s.selector.match_labels.clone());
    row
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
    let mut row = simple_row(s, cells);
    row.selector = s.spec.as_ref().and_then(|sp| sp.selector.match_labels.clone());
    row
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
    let mut row = simple_row(ds, cells);
    row.selector = ds.spec.as_ref().and_then(|s| s.selector.match_labels.clone());
    row
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
    // A job that terminated without succeeding has a `Failed` condition; the
    // problems view (B32) keys on it because the COMPLETIONS cell alone can't
    // tell a failed job from one still running.
    let failed = j
        .status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| cs.iter().any(|c| c.type_ == "Failed" && c.status == "True"))
        .unwrap_or(false);
    let cells = vec![
        name_cell(j),
        ns_cell(j),
        Cell::new(format!("{succeeded}/{completions}"), if complete { Tone::Secondary } else { Tone::Warn }),
        Cell::new(duration, Tone::Secondary),
        age_cell(j),
    ];
    let mut row = simple_row(j, cells);
    row.job = Some(JobMeta { failed });
    row
}

/// CronJobs: NAME, NAMESPACE, SCHEDULE, SUSPENDED, LAST RUN, AGE.
pub fn map_cronjob(c: &CronJob) -> Row {
    let suspended = c.spec.as_ref().and_then(|s| s.suspend).unwrap_or(false);
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
        // A suspended schedule reads muted — it's paused, not broken (B47).
        Cell::new(if suspended { "yes" } else { "no" }, if suspended { Tone::Muted } else { Tone::Secondary }),
        Cell::new(last_run, Tone::Secondary),
        age_cell(c),
    ];
    let mut row = simple_row(c, cells);
    row.cron = Some(CronMeta { suspended });
    row
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

/// The annotation marking an IngressClass as the cluster default.
const DEFAULT_INGRESS_CLASS_ANNOTATION: &str = "ingressclass.kubernetes.io/is-default-class";

/// IngressClasses: NAME, CONTROLLER, PARAMETERS, AGE. Cluster-scoped.
/// The default is marked in the name, as kubectl does — which controller picks up
/// an Ingress that names no class is the question this answers.
pub fn map_ingressclass(ic: &IngressClass) -> Row {
    let is_default = ic
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(DEFAULT_INGRESS_CLASS_ANNOTATION))
        .is_some_and(|v| v == "true");
    let name = if is_default {
        format!("{} (default)", ic.name_any())
    } else {
        ic.name_any()
    };
    let spec = ic.spec.as_ref();

    // Parameters point at a controller-specific config object when set; usually
    // absent, but when present it's the only pointer to how the class is tuned.
    let parameters = spec
        .and_then(|s| s.parameters.as_ref())
        .map(|p| format!("{}/{}", p.kind, p.name))
        .unwrap_or_else(|| "—".into());

    let cells = vec![
        Cell::new(name, Tone::Primary),
        Cell::new(
            spec.and_then(|s| s.controller.clone()).unwrap_or_else(|| "—".into()),
            Tone::Secondary,
        ),
        Cell::new(parameters, Tone::Secondary),
        age_cell(ic),
    ];
    Row {
        uid: uid_of(ic),
        name: ic.name_any(),
        namespace: None,
        cells,
        ..Default::default()
    }
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

/// ServiceAccounts: NAME, NAMESPACE, SECRETS, AGE.
///
/// SECRETS keeps kubectl's column even though Kubernetes stopped auto-creating
/// token Secrets in 1.24, so it reads 0 on any modern cluster (all 69 of freya's
/// do). It earns its place by the exception: a non-zero count means someone
/// attached a long-lived token by hand, which is exactly the thing worth
/// noticing — so it's toned rather than left as flat data.
pub fn map_serviceaccount(sa: &ServiceAccount) -> Row {
    let secrets = sa.secrets.as_ref().map(|s| s.len()).unwrap_or(0);
    let cells = vec![
        name_cell(sa),
        ns_cell(sa),
        Cell::new(
            secrets.to_string(),
            if secrets > 0 { Tone::Warn } else { Tone::Secondary },
        ),
        age_cell(sa),
    ];
    simple_row(sa, cells)
}

// ---------------------------------------------------------------------------
// RBAC (B49)
// ---------------------------------------------------------------------------

/// Roles: NAME, NAMESPACE, RULES, AGE. A role's worth is its rule count at a
/// glance; the panel carries the full verb×resource breakdown.
pub fn map_role(r: &Role) -> Row {
    let rules = r.rules.as_ref().map(|r| r.len()).unwrap_or(0);
    simple_row(
        r,
        vec![
            name_cell(r),
            ns_cell(r),
            Cell::new(rules.to_string(), Tone::Secondary),
            age_cell(r),
        ],
    )
}

/// ClusterRoles: NAME, RULES, AGE (cluster-scoped).
pub fn map_clusterrole(cr: &ClusterRole) -> Row {
    let rules = cr.rules.as_ref().map(|r| r.len()).unwrap_or(0);
    simple_row(
        cr,
        vec![name_cell(cr), Cell::new(rules.to_string(), Tone::Secondary), age_cell(cr)],
    )
}

/// RoleBindings: NAME, NAMESPACE, ROLE, SUBJECTS, AGE. The role cell links to
/// the referenced Role/ClusterRole; subjects render as "Kind/name" pairs.
pub fn map_rolebinding(b: &RoleBinding) -> Row {
    let (role, _) = role_ref_cell(b.role_ref.kind.as_str(), &b.role_ref.name, b.namespace().as_deref());
    simple_row(
        b,
        vec![
            name_cell(b),
            ns_cell(b),
            role,
            Cell::new(subjects_text(b.subjects.as_ref()), Tone::Secondary),
            age_cell(b),
        ],
    )
}

/// ClusterRoleBindings: NAME, ROLE, SUBJECTS, AGE (cluster-scoped).
pub fn map_clusterrolebinding(b: &ClusterRoleBinding) -> Row {
    let (role, _) = role_ref_cell(b.role_ref.kind.as_str(), &b.role_ref.name, None);
    simple_row(
        b,
        vec![
            name_cell(b),
            role,
            Cell::new(subjects_text(b.subjects.as_ref()), Tone::Secondary),
            age_cell(b),
        ],
    )
}

/// A cell for a binding's role reference, linking to the referenced
/// Role/ClusterRole. `binding_ns` is the binding's own namespace — a namespaced
/// Role lives there; a ClusterRole is cluster-wide.
fn role_ref_cell(kind: &str, name: &str, binding_ns: Option<&str>) -> (Cell, Option<NavTarget>) {
    let target = match kind {
        "Role" => Some(NavTarget::namespaced("roles", binding_ns.unwrap_or_default(), name)),
        "ClusterRole" => Some(NavTarget::cluster("clusterroles", name)),
        _ => None,
    };
    (Cell::link(name.to_string(), Tone::Secondary, target.clone()), target)
}

/// "ServiceAccount/prometheus, Group/team, User/alice" — a binding's subjects.
fn subjects_text(subjects: Option<&Vec<k8s_openapi::api::rbac::v1::Subject>>) -> String {
    subjects
        .map(|s| {
            s.iter()
                .map(|sub| format!("{}/{}", sub.kind, sub.name))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Access modes in kubectl's shorthand: RWO / ROX / RWX / RWOP, comma-joined.
/// An unrecognised mode passes through verbatim rather than being dropped.
fn access_modes(modes: Option<&Vec<String>>) -> String {
    let short = |m: &String| match m.as_str() {
        "ReadWriteOnce" => "RWO".to_string(),
        "ReadOnlyMany" => "ROX".to_string(),
        "ReadWriteMany" => "RWX".to_string(),
        "ReadWriteOncePod" => "RWOP".to_string(),
        other => other.to_string(),
    };
    match modes {
        Some(ms) if !ms.is_empty() => ms.iter().map(short).collect::<Vec<_>>().join(","),
        _ => "—".to_string(),
    }
}

/// Tone for a PersistentVolumeClaim phase. Unlike the shared `status_tone`, an
/// unknown phase here is a warning rather than an error: a claim in an
/// unrecognised state is odd, not necessarily broken.
fn pvc_tone(phase: &str) -> Tone {
    match phase {
        "Bound" => Tone::Good,
        // A Pending claim is the normal resting state for WaitForFirstConsumer
        // binding — it's waiting for a pod, not failing.
        "Pending" => Tone::Warn,
        "Lost" => Tone::Bad,
        _ => Tone::Warn,
    }
}

/// Tone for a PersistentVolume phase. `Available` is healthy-but-unclaimed, which
/// is why this can't reuse the shared `status_tone` (whose catch-all is red).
fn pv_tone(phase: &str) -> Tone {
    match phase {
        "Bound" => Tone::Good,
        // Provisioned and waiting for a claim: idle, not a problem.
        "Available" => Tone::Secondary,
        // Its claim is gone but the volume (and its data) still exists — it needs
        // a decision, so it reads amber rather than green or red.
        "Released" | "Pending" => Tone::Warn,
        "Failed" => Tone::Bad,
        _ => Tone::Warn,
    }
}

/// PersistentVolumeClaims: NAME, NAMESPACE, STATUS, VOLUME, CAPACITY, ACCESS,
/// CLASS, AGE.
pub fn map_pvc(pvc: &PersistentVolumeClaim) -> Row {
    let spec = pvc.spec.as_ref();
    let status = pvc.status.as_ref();
    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Pending".into());
    let tone = pvc_tone(&phase);

    // Bound capacity is authoritative; a Pending claim has none yet, so fall back
    // to what it asked for — otherwise the column is empty exactly when you're
    // looking to see how big the claim was.
    let capacity = status
        .and_then(|s| s.capacity.as_ref())
        .and_then(|c| c.get("storage"))
        .or_else(|| {
            spec.and_then(|s| s.resources.as_ref())
                .and_then(|r| r.requests.as_ref())
                .and_then(|r| r.get("storage"))
        })
        .map(|q| q.0.clone())
        .unwrap_or_else(|| "—".into());

    let cells = vec![
        name_cell(pvc),
        ns_cell(pvc),
        Cell::status(&phase, tone),
        Cell::new(
            spec.and_then(|s| s.volume_name.clone()).filter(|v| !v.is_empty()).unwrap_or_else(|| "—".into()),
            Tone::Secondary,
        ),
        Cell::new(capacity, Tone::Secondary),
        Cell::new(access_modes(spec.and_then(|s| s.access_modes.as_ref())), Tone::Secondary),
        Cell::new(
            spec.and_then(|s| s.storage_class_name.clone()).unwrap_or_else(|| "—".into()),
            Tone::Secondary,
        ),
        age_cell(pvc),
    ];
    simple_row(pvc, cells)
}

/// PersistentVolumes: NAME, CAPACITY, ACCESS, RECLAIM, STATUS, CLAIM, CLASS, AGE.
/// Cluster-scoped, so no NAMESPACE column — the CLAIM carries "namespace/name".
pub fn map_pv(pv: &PersistentVolume) -> Row {
    let spec = pv.spec.as_ref();
    let phase = pv
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Pending".into());
    let tone = pv_tone(&phase);

    let capacity = spec
        .and_then(|s| s.capacity.as_ref())
        .and_then(|c| c.get("storage"))
        .map(|q| q.0.clone())
        .unwrap_or_else(|| "—".into());

    // The bound claim, as kubectl shows it: "namespace/name".
    let claim = spec
        .and_then(|s| s.claim_ref.as_ref())
        .map(|c| {
            format!(
                "{}/{}",
                c.namespace.clone().unwrap_or_default(),
                c.name.clone().unwrap_or_default()
            )
        })
        .unwrap_or_else(|| "—".into());

    let cells = vec![
        name_cell(pv),
        Cell::new(capacity, Tone::Secondary),
        Cell::new(access_modes(spec.and_then(|s| s.access_modes.as_ref())), Tone::Secondary),
        Cell::new(
            spec.and_then(|s| s.persistent_volume_reclaim_policy.clone()).unwrap_or_else(|| "—".into()),
            Tone::Secondary,
        ),
        Cell::status(&phase, tone),
        Cell::new(claim, Tone::Secondary),
        Cell::new(
            spec.and_then(|s| s.storage_class_name.clone()).filter(|c| !c.is_empty()).unwrap_or_else(|| "—".into()),
            Tone::Secondary,
        ),
        age_cell(pv),
    ];
    Row {
        uid: uid_of(pv),
        name: pv.name_any(),
        namespace: None,
        cells,
        ..Default::default()
    }
}

/// The annotation marking a StorageClass as the cluster default.
const DEFAULT_CLASS_ANNOTATION: &str = "storageclass.kubernetes.io/is-default-class";

/// StorageClasses: NAME, PROVISIONER, RECLAIM, BINDING, EXPANSION, AGE.
/// Cluster-scoped. The default class is marked in the name, as kubectl does —
/// which class a claim gets when it names none is the question you open this to
/// answer.
pub fn map_storageclass(sc: &StorageClass) -> Row {
    let is_default = sc
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(DEFAULT_CLASS_ANNOTATION))
        .is_some_and(|v| v == "true");
    let name = if is_default {
        format!("{} (default)", sc.name_any())
    } else {
        sc.name_any()
    };

    let cells = vec![
        Cell::new(name, Tone::Primary),
        Cell::new(sc.provisioner.clone(), Tone::Secondary),
        Cell::new(
            sc.reclaim_policy.clone().unwrap_or_else(|| "Delete".into()),
            Tone::Secondary,
        ),
        Cell::new(
            sc.volume_binding_mode.clone().unwrap_or_else(|| "Immediate".into()),
            Tone::Secondary,
        ),
        Cell::new(
            match sc.allow_volume_expansion {
                Some(true) => "true",
                _ => "false",
            },
            Tone::Secondary,
        ),
        age_cell(sc),
    ];
    Row {
        uid: uid_of(sc),
        name: sc.name_any(),
        namespace: None,
        cells,
        ..Default::default()
    }
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
        ..Default::default()
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
        ..Default::default()
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
        // The object this event is about, for click-through (B33). The involved
        // object's own namespace is preferred; it usually equals the event's but
        // can differ (and cluster-scoped targets have none).
        involved: e.involved_object.kind.as_ref().map(|kind| InvolvedRef {
            kind: kind.clone(),
            name: e.involved_object.name.clone().unwrap_or_default(),
            namespace: e.involved_object.namespace.clone(),
            api_version: e.involved_object.api_version.clone(),
        }),
        ..Default::default()
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
/// only), then the CRD's own printer columns evaluated live (B30), then AGE.
///
/// A CRD's schema is arbitrary, so without per-CRD knowledge the generic set is
/// just identity + age; the printer columns are the CRD's own declaration of
/// what it wants shown, and we already fetch the full CRD at discovery. The
/// column set must match `kinds.ts`'s custom columns.
pub fn map_dynamic(o: &kube::core::DynamicObject, namespaced: bool, columns: &[PrinterColumn]) -> Row {
    let mut cells = vec![Cell::new(o.name_any(), Tone::Primary)];
    if namespaced {
        cells.push(Cell::new(o.namespace().unwrap_or_default(), Tone::Muted));
    }
    for col in columns {
        cells.push(printer_cell(o, col));
    }
    cells.push(Cell::age(o.creation_timestamp().map(|t| t.0.to_rfc3339())));

    Row {
        uid: uid_of(o),
        name: o.name_any(),
        namespace: o.namespace(),
        cells,
        ..Default::default()
    }
}

/// Evaluate one printer column against an object. `date`-typed columns render
/// through the age cell (the frontend formats the RFC3339 timestamp it carries);
/// everything else is plain secondary text. V1 takes no colour opinions on
/// arbitrary CRD columns, so tone stays Secondary throughout.
fn printer_cell(o: &kube::core::DynamicObject, col: &PrinterColumn) -> Cell {
    match jsonpath::eval(&col.json_path, &o.data) {
        // Missing is normal (optional status fields) and silent; unsupported
        // syntax is a coverage gap worth hearing about once per expression.
        jsonpath::Eval::Value(text) if col.type_ == "date" => Cell::age(Some(text)),
        jsonpath::Eval::Value(text) => Cell::new(text, Tone::Secondary),
        jsonpath::Eval::Missing => Cell::new("—", Tone::Secondary),
        jsonpath::Eval::Unsupported => {
            warn_once_unevaluable(&col.json_path);
            Cell::new("—", Tone::Secondary)
        }
    }
}

/// Log a printer column whose JSONPath is outside the evaluator's subset, at
/// most once per expression across the process lifetime. A kind with dozens of
/// objects must not spam the log on every row.
fn warn_once_unevaluable(path: &str) {
    static SEEN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    let seen = SEEN.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    let mut guard = match seen.lock() {
        Ok(g) => g,
        // Poisoned lock: logging is best-effort; carry on without the dedupe.
        Err(p) => p.into_inner(),
    };
    if guard.insert(path.to_string()) {
        tracing::warn!("printer column jsonPath unsupported by the subset (shows '—'): {path}");
    }
}

/// Build a namespaced Row from prebuilt cells (shared by the simple kinds).
fn simple_row<K: ResourceExt>(obj: &K, cells: Vec<Cell>) -> Row {
    Row {
        uid: uid_of(obj),
        name: obj.name_any(),
        namespace: obj.namespace(),
        cells,
        ..Default::default()
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

    /// Pod resources sum across the regular containers, so the Metrics overlay
    /// lines up with the (likewise summed) usage feed.
    #[test]
    fn pod_resources_sum_across_containers() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "two", "namespace": "prod", "uid": "r1" },
            "spec": { "containers": [
                { "name": "app", "resources": {
                    "requests": { "cpu": "250m", "memory": "256Mi" },
                    "limits": { "cpu": "500m", "memory": "512Mi" } } },
                { "name": "side", "resources": {
                    "requests": { "cpu": "100m", "memory": "64Mi" },
                    "limits": { "cpu": "200m", "memory": "128Mi" } } }
            ]}
        })).unwrap();
        let r = map_pod(&pod).pod.unwrap().resources;
        assert_eq!(r.cpu_request_millis, Some(350));
        assert_eq!(r.cpu_limit_millis, Some(700));
        assert_eq!(r.mem_request_bytes, Some((256 + 64) * 1024 * 1024));
        assert_eq!(r.mem_limit_bytes, Some((512 + 128) * 1024 * 1024));
    }

    /// One uncapped container makes the pod uncapped: the limit total drops to
    /// None (no ceiling line), while the request total still sums what's set.
    #[test]
    fn pod_resources_uncapped_container_has_no_limit() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "mixed", "namespace": "prod", "uid": "r2" },
            "spec": { "containers": [
                { "name": "app", "resources": {
                    "requests": { "cpu": "250m" },
                    "limits": { "cpu": "500m" } } },
                { "name": "side", "resources": { "requests": { "cpu": "100m" } } }
            ]}
        })).unwrap();
        let r = map_pod(&pod).pod.unwrap().resources;
        assert_eq!(r.cpu_request_millis, Some(350), "requests still sum");
        assert_eq!(r.cpu_limit_millis, None, "an uncapped container means no ceiling");
        assert_eq!(r.mem_request_bytes, None, "no memory requests set");
        assert_eq!(r.mem_limit_bytes, None);
    }

    /// A pod with no resources at all reports all-None rather than zeros, so the
    /// overlay draws nothing instead of a misleading line at zero.
    #[test]
    fn pod_resources_absent_are_none() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "bare", "namespace": "prod", "uid": "r3" },
            "spec": { "containers": [{ "name": "app" }] }
        })).unwrap();
        let r = map_pod(&pod).pod.unwrap().resources;
        assert_eq!(r.cpu_request_millis, None);
        assert_eq!(r.cpu_limit_millis, None);
        assert_eq!(r.mem_request_bytes, None);
        assert_eq!(r.mem_limit_bytes, None);
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

    /// A Deployment carries its pod selector for the "view pods" jump (B33).
    #[test]
    fn deployment_carries_selector() {
        let dep: Deployment = serde_json::from_value(json!({
            "metadata": { "name": "wiki", "namespace": "wiki", "uid": "d2" },
            "spec": { "replicas": 1, "selector": { "matchLabels": { "app": "wiki", "tier": "web" } } },
        }))
        .unwrap();
        let sel = map_deployment(&dep).selector.expect("selector present");
        assert_eq!(sel.get("app").map(String::as_str), Some("wiki"));
        assert_eq!(sel.get("tier").map(String::as_str), Some("web"));
    }

    /// A pod carries its labels so the selector filter can match it (B33).
    #[test]
    fn pod_carries_labels() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "wiki-x", "namespace": "wiki", "uid": "p2",
                          "labels": { "app": "wiki" } },
            "spec": { "containers": [{ "name": "app" }] },
            "status": { "phase": "Running" },
        }))
        .unwrap();
        let labels = map_pod(&pod).labels.expect("labels present");
        assert_eq!(labels.get("app").map(String::as_str), Some("wiki"));
    }

    /// A ReplicaSet at its desired size, and a superseded generation. The point of
    /// the second: 0-desired is normal history, so it must read muted rather than
    /// amber — otherwise every Deployment's old generations look broken.
    #[test]
    fn replicaset_scaled_down_reads_as_history() {
        let rs = |desired: i32, ready: i32| -> ReplicaSet {
            serde_json::from_value(json!({
                "metadata": { "name": "api-6c8d9", "namespace": "prod", "uid": "r1" },
                "spec": { "replicas": desired },
                "status": { "replicas": desired, "readyReplicas": ready },
            }))
            .unwrap()
        };
        // Columns: NAME,NAMESPACE,DESIRED,CURRENT,READY,AGE
        let live = map_replicaset(&rs(2, 2));
        assert_eq!(live.cells[2].text, "2");
        assert_eq!(live.cells[4].tone, Tone::Secondary, "fully ready");

        let degraded = map_replicaset(&rs(2, 1));
        assert_eq!(degraded.cells[4].tone, Tone::Warn, "a shortfall is amber");

        let superseded = map_replicaset(&rs(0, 0));
        assert_eq!(superseded.cells[2].tone, Tone::Muted);
        assert_eq!(superseded.cells[4].tone, Tone::Muted, "0/0 is history, not a fault");
    }

    /// The default StorageClass is marked in the NAME the way kubectl does — which
    /// class a claim gets when it names none is what you open this table to learn.
    /// The row's `name` stays the bare object name.
    #[test]
    fn storageclass_marks_the_default() {
        let sc = |default: bool| -> StorageClass {
            serde_json::from_value(json!({
                "metadata": { "name": "local-path", "uid": "s1",
                              "annotations": if default {
                                  json!({ "storageclass.kubernetes.io/is-default-class": "true" })
                              } else { json!({}) } },
                "provisioner": "rancher.io/local-path",
                "reclaimPolicy": "Delete",
                "volumeBindingMode": "WaitForFirstConsumer",
            }))
            .unwrap()
        };
        let row = map_storageclass(&sc(true));
        assert_eq!(row.cells[0].text, "local-path (default)");
        assert_eq!(row.name, "local-path", "identity is the real name, not the label");
        assert_eq!(row.namespace, None, "StorageClasses are cluster-scoped");
        assert_eq!(row.cells[1].text, "rancher.io/local-path");
        assert_eq!(row.cells[3].text, "WaitForFirstConsumer");
        // Defaults when the fields are absent.
        assert_eq!(row.cells[4].text, "false", "expansion absent → false");

        assert_eq!(map_storageclass(&sc(false)).cells[0].text, "local-path");
    }

    /// A ServiceAccount's SECRETS column is 0 on any cluster since 1.24 — the
    /// column earns its place by the exception, so a hand-attached token reads
    /// amber rather than blending in as ordinary data.
    #[test]
    fn serviceaccount_flags_a_hand_attached_token() {
        let sa = |secrets: serde_json::Value| -> ServiceAccount {
            serde_json::from_value(json!({
                "metadata": { "name": "ci", "namespace": "prod", "uid": "a1" },
                "secrets": secrets,
            }))
            .unwrap()
        };
        // Columns: NAME,NAMESPACE,SECRETS,AGE
        let modern = map_serviceaccount(&sa(json!([])));
        assert_eq!(modern.cells[2].text, "0");
        assert_eq!(modern.cells[2].tone, Tone::Secondary);

        let legacy = map_serviceaccount(&sa(json!([{ "name": "ci-token-abc" }])));
        assert_eq!(legacy.cells[2].text, "1");
        assert_eq!(legacy.cells[2].tone, Tone::Warn, "a long-lived token is worth noticing");
    }

    // ---- Storage: PVCs and PVs ----

    /// A bound claim: columns NAME,NAMESPACE,STATUS,VOLUME,CAPACITY,ACCESS,CLASS,AGE,
    /// status green with a dot, access modes in kubectl's shorthand.
    #[test]
    fn bound_pvc_columns() {
        let pvc: PersistentVolumeClaim = serde_json::from_value(json!({
            "metadata": { "name": "wiki-postgres-data", "namespace": "wiki", "uid": "c1" },
            "spec": { "volumeName": "pvc-5a948cc3", "storageClassName": "local-path",
                      "accessModes": ["ReadWriteOnce"],
                      "resources": { "requests": { "storage": "5Gi" } } },
            "status": { "phase": "Bound", "capacity": { "storage": "5Gi" } },
        }))
        .unwrap();
        let row = map_pvc(&pvc);
        assert_eq!(row.cells[2].text, "Bound");
        assert_eq!(row.cells[2].tone, Tone::Good);
        assert!(row.cells[2].dot);
        assert_eq!(row.cells[3].text, "pvc-5a948cc3");
        assert_eq!(row.cells[4].text, "5Gi");
        assert_eq!(row.cells[5].text, "RWO", "access modes use kubectl's shorthand");
        assert_eq!(row.cells[6].text, "local-path");
    }

    /// A Pending claim has no bound capacity yet, so the column falls back to the
    /// *requested* size — otherwise it's blank exactly when you want to know how
    /// big the claim was.
    #[test]
    fn pending_pvc_shows_requested_capacity() {
        let pvc: PersistentVolumeClaim = serde_json::from_value(json!({
            "metadata": { "name": "reports", "namespace": "prod", "uid": "c2" },
            "spec": { "accessModes": ["ReadWriteMany"],
                      "resources": { "requests": { "storage": "100Gi" } } },
            "status": { "phase": "Pending" },
        }))
        .unwrap();
        let row = map_pvc(&pvc);
        assert_eq!(row.cells[2].tone, Tone::Warn, "Pending is a wait, not a failure");
        assert_eq!(row.cells[3].text, "—", "no volume bound yet");
        assert_eq!(row.cells[4].text, "100Gi", "falls back to the request");
        assert_eq!(row.cells[5].text, "RWX");
    }

    /// A bound volume: cluster-scoped (no namespace), and CLAIM reads
    /// "namespace/name" the way kubectl prints it.
    #[test]
    fn bound_pv_columns() {
        let pv: PersistentVolume = serde_json::from_value(json!({
            "metadata": { "name": "pvc-5a948cc3", "uid": "v1" },
            "spec": { "capacity": { "storage": "5Gi" }, "accessModes": ["ReadWriteOnce"],
                      "persistentVolumeReclaimPolicy": "Delete", "storageClassName": "local-path",
                      "claimRef": { "namespace": "wiki", "name": "wiki-postgres-data" } },
            "status": { "phase": "Bound" },
        }))
        .unwrap();
        let row = map_pv(&pv);
        // Columns: NAME,CAPACITY,ACCESS,RECLAIM,STATUS,CLAIM,CLASS,AGE
        assert_eq!(row.namespace, None, "PVs are cluster-scoped");
        assert_eq!(row.cells[1].text, "5Gi");
        assert_eq!(row.cells[3].text, "Delete");
        assert_eq!(row.cells[4].text, "Bound");
        assert_eq!(row.cells[4].tone, Tone::Good);
        assert_eq!(row.cells[5].text, "wiki/wiki-postgres-data");
    }

    /// PV phases the *shared* status_tone would get wrong: an Available volume is
    /// idle (not an error), and a Released one needs a decision (amber, not red).
    /// That divergence is why PVs carry their own tone function.
    #[test]
    fn pv_phase_tones_differ_from_the_shared_helper() {
        let pv_with = |phase: &str| -> Row {
            let pv: PersistentVolume = serde_json::from_value(json!({
                "metadata": { "name": "v", "uid": "u" },
                "spec": { "capacity": { "storage": "1Gi" } },
                "status": { "phase": phase },
            }))
            .unwrap();
            map_pv(&pv)
        };
        assert_eq!(pv_with("Available").cells[4].tone, Tone::Secondary);
        assert_eq!(pv_with("Released").cells[4].tone, Tone::Warn);
        assert_eq!(pv_with("Failed").cells[4].tone, Tone::Bad);
        // The shared helper would have called both of these failures.
        assert_eq!(status_tone("Available"), Tone::Bad);
        assert_eq!(status_tone("Released"), Tone::Bad);
    }

    /// Multiple access modes join, and an unknown mode passes through rather than
    /// being silently dropped.
    #[test]
    fn access_mode_shorthand() {
        assert_eq!(access_modes(Some(&vec!["ReadWriteOnce".into()])), "RWO");
        assert_eq!(
            access_modes(Some(&vec!["ReadOnlyMany".into(), "ReadWriteMany".into()])),
            "ROX,RWX"
        );
        assert_eq!(access_modes(Some(&vec!["ReadWriteOncePod".into()])), "RWOP");
        assert_eq!(access_modes(Some(&vec!["FutureMode".into()])), "FutureMode");
        assert_eq!(access_modes(None), "—");
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

    /// The involvedObject is threaded onto the row for click-through (B33) — the
    /// object's own kind/name/namespace, not the event's display-string cell.
    #[test]
    fn event_carries_involved_object() {
        let inv = map_event(&event("Warning", "FailedMount", "2026-07-16T09:00:00Z"))
            .involved
            .expect("involved present");
        assert_eq!(inv.kind, "Pod");
        assert_eq!(inv.name, "my-pod");
        assert_eq!(inv.namespace.as_deref(), Some("prod"));
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

    // -----------------------------------------------------------------------
    // CRD printer columns (B30)
    // -----------------------------------------------------------------------

    /// An Argo CD Application: NAME, NAMESPACE, then the CRD's declared columns
    /// evaluated live (Synced / Healthy), then AGE.
    #[test]
    fn dynamic_applies_printer_columns() {
        let o: kube::core::DynamicObject = serde_json::from_value(json!({
            "apiVersion": "argoproj.io/v1alpha1",
            "kind": "Application",
            "metadata": { "name": "valkyrie", "namespace": "argocd", "uid": "u1",
                          "creationTimestamp": "2026-08-01T00:00:00Z" },
            "status": { "sync": { "status": "Synced" }, "health": { "status": "Healthy" } },
        }))
        .unwrap();
        let cols = vec![
            PrinterColumn { name: "Sync Status".into(), type_: "string".into(), json_path: ".status.sync.status".into() },
            PrinterColumn { name: "Health Status".into(), type_: "string".into(), json_path: ".status.health.status".into() },
        ];
        let row = map_dynamic(&o, true, &cols);
        let texts: Vec<&str> = row.cells.iter().map(|c| c.text.as_str()).collect();
        // `to_rfc3339` emits +00:00 for UTC; the frontend's Date() parses both.
        assert_eq!(texts, ["valkyrie", "argocd", "Synced", "Healthy", "2026-08-01T00:00:00+00:00"]);
        // Printer data is secondary; the two identity columns keep their tones.
        assert_eq!(row.cells[2].tone, Tone::Secondary);
    }

    /// A column whose jsonPath doesn't resolve on this object (a status not yet
    /// set) renders "—" rather than guessing — silently, not an error.
    #[test]
    fn dynamic_missing_column_renders_dash() {
        let o: kube::core::DynamicObject = serde_json::from_value(json!({
            "apiVersion": "example.com/v1",
            "kind": "Widget",
            "metadata": { "name": "w", "namespace": "prod", "uid": "u1",
                          "creationTimestamp": "2026-08-01T00:00:00Z" },
            "spec": {},
        }))
        .unwrap();
        let cols = vec![
            PrinterColumn { name: "Phase".into(), type_: "string".into(), json_path: ".status.phase".into() },
        ];
        let row = map_dynamic(&o, true, &cols);
        assert_eq!(row.cells[2].text, "—");
    }

    /// `date`-typed columns render through the age cell so the frontend formats
    /// the timestamp into a k8s-style age, just like the object's own AGE.
    #[test]
    fn dynamic_date_column_renders_as_age() {
        let o: kube::core::DynamicObject = serde_json::from_value(json!({
            "apiVersion": "example.com/v1",
            "kind": "Widget",
            "metadata": { "name": "w", "namespace": "prod", "uid": "u1",
                          "creationTimestamp": "2026-08-01T00:00:00Z" },
            "status": { "lastTransition": "2026-08-10T08:30:00Z" },
        }))
        .unwrap();
        let cols = vec![
            PrinterColumn { name: "Last Transition".into(), type_: "date".into(), json_path: ".status.lastTransition".into() },
        ];
        let row = map_dynamic(&o, true, &cols);
        assert_eq!(row.cells[2].format, Some("age"));
        assert_eq!(row.cells[2].text, "2026-08-10T08:30:00Z");
    }

    /// With no printer columns the kind keeps the generic NAME, NAMESPACE, AGE
    /// set, and cluster-scoped kinds omit NAMESPACE.
    #[test]
    fn dynamic_without_columns_stays_generic() {
        let o: kube::core::DynamicObject = serde_json::from_value(json!({
            "apiVersion": "cert-manager.io/v1",
            "kind": "ClusterIssuer",
            "metadata": { "name": "letsencrypt-prod", "uid": "u1",
                          "creationTimestamp": "2026-08-01T00:00:00Z" },
        }))
        .unwrap();
        let namespaced_row = map_dynamic(&o, true, &[]);
        assert_eq!(namespaced_row.cells.len(), 3);
        let cluster_row = map_dynamic(&o, false, &[]);
        let texts: Vec<&str> = cluster_row.cells.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts, ["letsencrypt-prod", "2026-08-01T00:00:00+00:00"]);
    }

    // -----------------------------------------------------------------------
    // RBAC kinds (B49)
    // -----------------------------------------------------------------------

    /// A RoleBinding shows its role as a link (to the namespaced role) and its
    /// subjects as "Kind/name" pairs; a ClusterRole ref links cluster-wide.
    #[test]
    fn rolebinding_links_role_and_lists_subjects() {
        let b: RoleBinding = serde_json::from_value(json!({
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "RoleBinding",
            "metadata": { "name": "panoptes-prometheus", "namespace": "panoptes", "uid": "rb1" },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "prometheus" },
            "subjects": [
                { "kind": "ServiceAccount", "name": "prometheus", "namespace": "panoptes" },
                { "kind": "User", "name": "alice" },
            ],
        }))
        .unwrap();
        let row = map_rolebinding(&b);
        // NAME, NAMESPACE, ROLE, SUBJECTS, AGE.
        assert_eq!(row.cells[2].text, "prometheus");
        assert_eq!(row.cells[2].nav.as_ref().map(|t| t.kind.as_str()), Some("clusterroles"));
        assert_eq!(row.cells[3].text, "ServiceAccount/prometheus, User/alice");
    }

    /// A namespaced Role ref links to the role in the binding's namespace.
    #[test]
    fn namespaced_role_ref_links_to_roles() {
        let b: RoleBinding = serde_json::from_value(json!({
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "RoleBinding",
            "metadata": { "name": "rb", "namespace": "prod", "uid": "rb2" },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "deployer" },
        }))
        .unwrap();
        let row = map_rolebinding(&b);
        assert_eq!(row.cells[2].nav.as_ref().map(|t| t.kind.as_str()), Some("roles"));
        assert_eq!(row.cells[2].nav.as_ref().and_then(|t| t.namespace.as_deref()), Some("prod"));
    }

    /// A Role's RULES column is its rule count.
    #[test]
    fn role_counts_its_rules() {
        let r: Role = serde_json::from_value(json!({
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "Role",
            "metadata": { "name": "deployer", "namespace": "prod", "uid": "r1" },
            "rules": [
                { "verbs": ["get", "list"], "resources": ["deployments"], "apiGroups": ["apps"] },
                { "verbs": ["update"], "resources": ["deployments/scale"], "apiGroups": ["apps"] },
            ],
        }))
        .unwrap();
        let row = map_role(&r);
        // NAME, NAMESPACE, RULES, AGE.
        assert_eq!(row.cells[2].text, "2");
        assert!(row.namespace.is_some());
    }

    // -----------------------------------------------------------------------
    // CronJob suspend state (B47)
    // -----------------------------------------------------------------------

    /// A suspended CronJob reads a muted "yes" in the SUSPENDED column and
    /// carries the state, so the Suspend/Resume actions can gate on it.
    #[test]
    fn cronjob_suspended_column_and_meta() {
        let cj: CronJob = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "CronJob",
            "metadata": { "name": "cache-warm", "namespace": "prod", "uid": "cj1" },
            "spec": { "schedule": "*/15 * * * *", "suspend": true },
        }))
        .unwrap();
        let row = map_cronjob(&cj);
        // NAME, NAMESPACE, SCHEDULE, SUSPENDED, LAST RUN, AGE.
        assert_eq!(row.cells.len(), 6);
        assert_eq!((row.cells[3].text.as_str(), row.cells[3].tone), ("yes", Tone::Muted));
        assert_eq!(row.cron.map(|c| c.suspended), Some(true));

        let cj2: CronJob = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "CronJob",
            "metadata": { "name": "report-gen", "namespace": "prod", "uid": "cj2" },
            "spec": { "schedule": "0 */6 * * *" },
        }))
        .unwrap();
        let row2 = map_cronjob(&cj2);
        assert_eq!(row2.cells[3].text, "no");
        assert_eq!(row2.cron.map(|c| c.suspended), Some(false));
    }

    // -----------------------------------------------------------------------
    // Job failure flag (B32)
    // -----------------------------------------------------------------------

    /// A job with a `Failed` condition carries it on the row, so the problems
    /// view can tell a failed job from one still running (both show "0/1").
    #[test]
    fn job_carries_failed_flag() {
        let j: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "migrate", "namespace": "prod", "uid": "u1" },
            "spec": { "completions": 1 },
            "status": {
                "succeeded": 0,
                "startTime": "2026-08-01T00:00:00Z",
                "completionTime": "2026-08-01T00:01:00Z",
                "conditions": [{ "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded" }],
            },
        }))
        .unwrap();
        let row = map_job(&j);
        assert_eq!(row.job.map(|j| j.failed), Some(true));
    }

    /// A healthy (or still-running) job has no Failed condition.
    #[test]
    fn running_job_is_not_failed() {
        let j: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "migrate", "namespace": "prod", "uid": "u1" },
            "spec": { "completions": 1 },
            "status": { "succeeded": 0, "startTime": "2026-08-01T00:00:00Z" },
        }))
        .unwrap();
        let row = map_job(&j);
        assert_eq!(row.job.map(|j| j.failed), Some(false));
    }
}
