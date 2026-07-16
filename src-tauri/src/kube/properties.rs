//! Pod properties (B13): the "what is this pod actually wired to" view.
//!
//! Gathers, in one call, the things you'd otherwise dig out of YAML or several
//! kubectl commands:
//!   - identity/placement (node, IPs, QoS, service account, owner, priority)
//!   - containers (image, state, restarts, resource requests/limits, ports)
//!   - volumes, resolving PVC → PV to show capacity/class/access modes/phase and
//!     where each is mounted
//!   - Services whose selector matches this pod's labels
//!
//! Every lookup beyond the pod itself is best-effort: a missing PVC/PV or an RBAC
//! denial degrades that row rather than failing the whole panel.

use crate::error::{AppError, AppResult};
use k8s_openapi::api::core::v1::{
    PersistentVolume, PersistentVolumeClaim, Pod, Service,
};
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use std::collections::BTreeMap;

/// A label/annotation entry (serialized as a list to keep frontend rendering simple).
#[derive(Serialize, Clone)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// Per-container summary.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restarts: i32,
    /// "Running" | "Waiting: Reason" | "Terminated: Reason" | "Unknown".
    pub state: String,
    /// e.g. "100m / 1" (request / limit); "—" when unset.
    pub cpu: String,
    pub memory: String,
    /// "8080/TCP, 9090/TCP" or "—".
    pub ports: String,
}

/// A volume attached to the pod. PVC-backed volumes carry the resolved
/// claim/PV details; other kinds just report their type.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// Volume name as declared in the pod spec.
    pub name: String,
    /// "PVC" | "ConfigMap" | "Secret" | "EmptyDir" | "HostPath" | "Projected" | …
    pub kind: String,
    /// Where containers mount it ("/data, /var/lib" or "—").
    pub mount_paths: String,
    pub read_only: bool,
    // --- PVC/PV details (empty for non-PVC volumes) ---
    pub claim: String,
    pub pv: String,
    pub capacity: String,
    pub storage_class: String,
    pub access_modes: String,
    /// PVC phase: Bound / Pending / Lost.
    pub phase: String,
}

/// A Service whose selector matches this pod.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub cluster_ip: String,
    pub ports: String,
}

/// Everything the Properties tab renders.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodProperties {
    pub node: String,
    pub pod_ip: String,
    pub host_ip: String,
    pub qos_class: String,
    pub service_account: String,
    pub priority_class: String,
    pub restart_policy: String,
    /// RFC3339; the frontend formats it as an age.
    pub start_time: String,
    /// e.g. "ReplicaSet/valkyrie-api-7d9f8b64d".
    pub owner: String,
    pub labels: Vec<KeyValue>,
    pub annotations: Vec<KeyValue>,
    pub containers: Vec<ContainerInfo>,
    pub volumes: Vec<VolumeInfo>,
    pub services: Vec<ServiceInfo>,
}

/// Placeholder for an unset value (matches the tables' em dash).
const DASH: &str = "—";

fn or_dash(s: Option<String>) -> String {
    s.filter(|v| !v.is_empty()).unwrap_or_else(|| DASH.into())
}

/// Map a BTreeMap of labels/annotations into a sorted KeyValue list.
fn to_kv(map: Option<&BTreeMap<String, String>>) -> Vec<KeyValue> {
    map.map(|m| {
        m.iter()
            .map(|(k, v)| KeyValue { key: k.clone(), value: v.clone() })
            .collect()
    })
    .unwrap_or_default()
}

/// Gather all properties for a pod.
pub async fn gather(client: Client, namespace: &str, name: &str) -> AppResult<PodProperties> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = pods.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;

    let spec = pod.spec.clone().unwrap_or_default();
    let status = pod.status.clone().unwrap_or_default();

    // ---- identity / placement ----
    let owner = pod
        .metadata
        .owner_references
        .as_ref()
        .and_then(|o| o.first())
        .map(|o| format!("{}/{}", o.kind, o.name))
        .unwrap_or_else(|| DASH.into());

    // ---- containers ----
    let statuses = status.container_statuses.clone().unwrap_or_default();
    let containers = spec
        .containers
        .iter()
        .map(|c| {
            let cs = statuses.iter().find(|s| s.name == c.name);
            let state = cs
                .and_then(|s| s.state.as_ref())
                .map(|st| {
                    if st.running.is_some() {
                        "Running".to_string()
                    } else if let Some(w) = &st.waiting {
                        format!("Waiting: {}", w.reason.clone().unwrap_or_default())
                    } else if let Some(t) = &st.terminated {
                        format!("Terminated: {}", t.reason.clone().unwrap_or_default())
                    } else {
                        "Unknown".to_string()
                    }
                })
                .unwrap_or_else(|| "Unknown".into());

            // "request / limit" per resource.
            let (cpu, memory) = match &c.resources {
                Some(r) => {
                    let get = |m: &Option<BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>, key: &str| {
                        m.as_ref().and_then(|m| m.get(key)).map(|q| q.0.clone())
                    };
                    let fmt = |key: &str| {
                        let req = get(&r.requests, key);
                        let lim = get(&r.limits, key);
                        match (req, lim) {
                            (None, None) => DASH.to_string(),
                            (r, l) => format!(
                                "{} / {}",
                                r.unwrap_or_else(|| DASH.into()),
                                l.unwrap_or_else(|| DASH.into())
                            ),
                        }
                    };
                    (fmt("cpu"), fmt("memory"))
                }
                None => (DASH.to_string(), DASH.to_string()),
            };

            let ports = c
                .ports
                .as_ref()
                .map(|ps| {
                    ps.iter()
                        .map(|p| {
                            format!(
                                "{}/{}",
                                p.container_port,
                                p.protocol.clone().unwrap_or_else(|| "TCP".into())
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DASH.into());

            ContainerInfo {
                name: c.name.clone(),
                image: c.image.clone().unwrap_or_else(|| DASH.into()),
                ready: cs.map(|s| s.ready).unwrap_or(false),
                restarts: cs.map(|s| s.restart_count).unwrap_or(0),
                state,
                cpu,
                memory,
                ports,
            }
        })
        .collect();

    // ---- volumes (resolving PVC → PV) ----
    let volumes = gather_volumes(&client, namespace, &spec).await;

    // ---- services selecting this pod ----
    let services = gather_services(&client, namespace, pod.metadata.labels.as_ref()).await;

    Ok(PodProperties {
        node: or_dash(spec.node_name.clone()),
        pod_ip: or_dash(status.pod_ip.clone()),
        host_ip: or_dash(status.host_ip.clone()),
        qos_class: or_dash(status.qos_class.clone()),
        service_account: or_dash(spec.service_account_name.clone()),
        priority_class: or_dash(spec.priority_class_name.clone()),
        restart_policy: or_dash(spec.restart_policy.clone()),
        start_time: status.start_time.map(|t| t.0.to_rfc3339()).unwrap_or_default(),
        owner,
        labels: to_kv(pod.metadata.labels.as_ref()),
        annotations: to_kv(pod.metadata.annotations.as_ref()),
        containers,
        volumes,
        services,
    })
}

/// Build the volume list, resolving PVC → PV where possible (best-effort).
async fn gather_volumes(
    client: &Client,
    namespace: &str,
    spec: &k8s_openapi::api::core::v1::PodSpec,
) -> Vec<VolumeInfo> {
    let pvcs: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
    let pvs: Api<PersistentVolume> = Api::all(client.clone());

    let mut out = Vec::new();
    for v in spec.volumes.iter().flatten() {
        // Where do containers mount this volume?
        let mut mounts: Vec<String> = Vec::new();
        let mut read_only = false;
        for c in &spec.containers {
            for m in c.volume_mounts.iter().flatten() {
                if m.name == v.name {
                    mounts.push(m.mount_path.clone());
                    read_only |= m.read_only.unwrap_or(false);
                }
            }
        }
        let mount_paths = if mounts.is_empty() {
            DASH.to_string()
        } else {
            mounts.join(", ")
        };

        let mut info = VolumeInfo {
            name: v.name.clone(),
            kind: volume_kind(v).to_string(),
            mount_paths,
            read_only,
            claim: String::new(),
            pv: String::new(),
            capacity: String::new(),
            storage_class: String::new(),
            access_modes: String::new(),
            phase: String::new(),
        };

        // Resolve PVC-backed volumes.
        if let Some(src) = &v.persistent_volume_claim {
            info.claim = src.claim_name.clone();
            if let Ok(pvc) = pvcs.get(&src.claim_name).await {
                let pvc_spec = pvc.spec.clone().unwrap_or_default();
                let pvc_status = pvc.status.clone().unwrap_or_default();
                info.phase = or_dash(pvc_status.phase.clone());
                info.storage_class = or_dash(pvc_spec.storage_class_name.clone());
                info.access_modes = pvc_spec
                    .access_modes
                    .map(|a| a.join(", "))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| DASH.into());
                // Capacity: prefer the bound status, fall back to the request.
                info.capacity = pvc_status
                    .capacity
                    .as_ref()
                    .and_then(|c| c.get("storage"))
                    .map(|q| q.0.clone())
                    .or_else(|| {
                        pvc_spec
                            .resources
                            .as_ref()
                            .and_then(|r| r.requests.as_ref())
                            .and_then(|r| r.get("storage"))
                            .map(|q| q.0.clone())
                    })
                    .unwrap_or_else(|| DASH.into());
                // Bound PV.
                if let Some(pv_name) = pvc_spec.volume_name.filter(|n| !n.is_empty()) {
                    info.pv = pv_name.clone();
                    // PV capacity is authoritative when present.
                    if let Ok(pv) = pvs.get(&pv_name).await {
                        if let Some(cap) = pv
                            .spec
                            .as_ref()
                            .and_then(|s| s.capacity.as_ref())
                            .and_then(|c| c.get("storage"))
                        {
                            info.capacity = cap.0.clone();
                        }
                    }
                } else {
                    info.pv = DASH.into();
                }
            } else {
                // PVC unreadable (deleted or RBAC): show what we know.
                info.phase = DASH.into();
                info.pv = DASH.into();
                info.capacity = DASH.into();
                info.storage_class = DASH.into();
                info.access_modes = DASH.into();
            }
        }

        out.push(info);
    }
    out
}

/// Classify a non-PVC volume by its source.
fn volume_kind(v: &k8s_openapi::api::core::v1::Volume) -> &'static str {
    if v.persistent_volume_claim.is_some() {
        "PVC"
    } else if v.config_map.is_some() {
        "ConfigMap"
    } else if v.secret.is_some() {
        "Secret"
    } else if v.empty_dir.is_some() {
        "EmptyDir"
    } else if v.host_path.is_some() {
        "HostPath"
    } else if v.projected.is_some() {
        "Projected"
    } else if v.downward_api.is_some() {
        "DownwardAPI"
    } else if v.nfs.is_some() {
        "NFS"
    } else if v.csi.is_some() {
        "CSI"
    } else {
        "Other"
    }
}

/// Services in the namespace whose selector matches the pod's labels.
async fn gather_services(
    client: &Client,
    namespace: &str,
    pod_labels: Option<&BTreeMap<String, String>>,
) -> Vec<ServiceInfo> {
    let Some(labels) = pod_labels else {
        return Vec::new();
    };
    let svcs: Api<Service> = Api::namespaced(client.clone(), namespace);
    let list = match svcs.list(&ListParams::default()).await {
        Ok(l) => l,
        Err(_) => return Vec::new(), // RBAC or transient: degrade to empty
    };

    list.items
        .into_iter()
        .filter_map(|s| {
            let spec = s.spec.as_ref()?;
            let selector = spec.selector.as_ref()?;
            // A service selects this pod when every selector entry matches a label.
            if selector.is_empty()
                || !selector
                    .iter()
                    .all(|(k, v)| labels.get(k).map(|lv| lv == v).unwrap_or(false))
            {
                return None;
            }
            let ports = spec
                .ports
                .as_ref()
                .map(|ps| {
                    ps.iter()
                        .map(|p| {
                            format!(
                                "{}/{}",
                                p.port,
                                p.protocol.clone().unwrap_or_else(|| "TCP".into())
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| DASH.into());
            Some(ServiceInfo {
                name: s.metadata.name.clone().unwrap_or_default(),
                type_: spec.type_.clone().unwrap_or_else(|| "ClusterIP".into()),
                cluster_ip: or_dash(spec.cluster_ip.clone()),
                ports,
            })
        })
        .collect()
}
