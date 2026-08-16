//! The resource topology graph (B55): ownership and reference edges around a
//! selected resource, for a visual "how does this wire together" view.
//!
//! No new data — this walks the same relationships the Properties panel and
//! related-navigation already resolve: owner references (solid edges) and
//! selector/backend references (dashed). The expansion is a bounded BFS, so a
//! "neighborhood" stays a neighborhood: the seed, its owners, its owned
//! children, and the Services/Ingresses that reference them.

use crate::error::AppResult;
use k8s_openapi::api::apps::v1::{DaemonSet, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::api::networking::v1::{Ingress, IngressBackend};
use kube::api::{Api, ListParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::{Client, ResourceExt};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet, VecDeque};

/// A node in the graph: one resource.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TopologyNode {
    /// Stable id, `"{nav}:{namespace}/{name}"`.
    pub id: String,
    /// Kubernetes Kind, e.g. "Deployment" (for the label).
    pub kind: String,
    pub namespace: String,
    pub name: String,
    /// The nav id a click navigates to ("deployments", "pods", …).
    pub nav: String,
}

/// A directed edge. `from` "owns or references" `to`.
#[derive(Serialize, Clone)]
pub struct TopologyEdge {
    pub from: String,
    pub to: String,
    /// "ownership" (solid) or "reference" (dashed).
    pub rel: &'static str,
}

#[derive(Serialize, Clone, Default)]
pub struct Topology {
    pub nodes: Vec<TopologyNode>,
    pub edges: Vec<TopologyEdge>,
}

/// Node budget — a neighborhood, not the whole cluster.
const MAX_NODES: usize = 16;

/// Build the topology around a seed resource.
pub async fn build(
    client: &Client,
    namespace: &str,
    seed_kind: &str,
    seed: &DynamicObject,
) -> AppResult<Topology> {
    let mut nodes: Vec<TopologyNode> = Vec::new();
    let mut edges: Vec<TopologyEdge> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // BFS queue: (nav id, kind, namespace, name).
    let mut queue: VecDeque<(String, String, String, String)> = VecDeque::new();

    let seed_nav = nav_for_kind(seed_kind).unwrap_or("").to_string();
    let seed_name = seed.metadata.name.clone().unwrap_or_default();
    if add_node(&mut nodes, &mut seen, &seed_nav, seed_kind, namespace, &seed_name) {
        queue.push_back((seed_nav, seed_kind.to_string(), namespace.to_string(), seed_name));
    }

    while let Some((nav, kind, ns, name)) = queue.pop_front() {
        if nodes.len() >= MAX_NODES {
            break;
        }
        // Fetch the node's object for its owner refs, labels and uid. A node
        // that vanished mid-expansion is skipped, not fatal.
        let Some(obj) = fetch(client, &nav, &ns, &name).await else { continue };
        let uid = obj.metadata.uid.clone();

        // ---- ownership ancestors: the controller that owns this ----
        if let Some(owners) = obj.metadata.owner_references.clone() {
            for owner in owners {
                let Some(owner_nav) = nav_for_kind(&owner.kind) else { continue };
                let owner_name = owner.name;
                let from = node_key(owner_nav, namespace, &owner_name);
                let to = node_key(&nav, &ns, &name);
                if add_node(&mut nodes, &mut seen, owner_nav, &owner.kind, namespace, &owner_name) {
                    edges.push(TopologyEdge { from, to, rel: "ownership" });
                    queue.push_back((owner_nav.to_string(), owner.kind, namespace.to_string(), owner_name));
                }
            }
        }

        // ---- ownership descendants: resources this controller owns ----
        if let Some(uid) = uid {
            let children = owned_children(client, namespace, &uid).await;
            for (c_kind, c_nav, c_ns, c_name) in children {
                let from = node_key(&nav, &ns, &name);
                let to = node_key(&c_nav, &c_ns, &c_name);
                if add_node(&mut nodes, &mut seen, &c_nav, &c_kind, &c_ns, &c_name) {
                    edges.push(TopologyEdge { from, to, rel: "ownership" });
                    queue.push_back((c_nav, c_kind, c_ns, c_name));
                }
            }
        }

        // ---- references: Services selecting a pod's labels ----
        if kind == "Pod" {
            if let Some(labels) = obj.metadata.labels.clone() {
                for (s_ns, s_name) in services_selecting(client, &ns, &labels).await {
                    let from = node_key("services", &s_ns, &s_name);
                    let to = node_key(&nav, &ns, &name);
                    if add_node(&mut nodes, &mut seen, "services", "Service", &s_ns, &s_name) {
                        edges.push(TopologyEdge { from, to, rel: "reference" });
                        queue.push_back(("services".to_string(), "Service".to_string(), s_ns, s_name));
                    }
                }
            }
        }

        // ---- references: Ingresses routing to a Service ----
        if kind == "Service" {
            for (i_ns, i_name) in ingresses_to_service(client, &ns, &name).await {
                let from = node_key("ingresses", &i_ns, &i_name);
                let to = node_key(&nav, &ns, &name);
                if add_node(&mut nodes, &mut seen, "ingresses", "Ingress", &i_ns, &i_name) {
                    edges.push(TopologyEdge { from, to, rel: "reference" });
                    queue.push_back(("ingresses".to_string(), "Ingress".to_string(), i_ns, i_name));
                }
            }
        }
    }

    Ok(Topology { nodes, edges })
}

/// The resources a uid owns: pods plus the template-controller kinds, so the
/// Deployment → ReplicaSet → Pod chain resolves regardless of which end you
/// start from.
async fn owned_children(client: &Client, namespace: &str, uid: &str) -> Vec<(String, String, String, String)> {
    let mut out = Vec::new();
    for (kind, nav) in [
        ("Pod", "pods"),
        ("ReplicaSet", "replicasets"),
        ("StatefulSet", "statefulsets"),
        ("DaemonSet", "daemonsets"),
        ("Job", "jobs"),
    ] {
        let items = list_owned(client, namespace, nav, uid).await;
        for (ns, name) in items {
            out.push((kind.to_string(), nav.to_string(), ns, name));
        }
    }
    out
}

/// List objects of `nav` whose owner uid matches, as (namespace, name).
async fn list_owned(client: &Client, namespace: &str, nav: &str, uid: &str) -> Vec<(String, String)> {
    let owned = |u: &str, o: &k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference| o.uid == u;
    let filter = |obj: &kube::core::ObjectMeta, uid: &str| {
        obj.owner_references
            .as_ref()
            .map(|r| r.iter().any(|o| owned(uid, o)))
            .unwrap_or(false)
    };
    match nav {
        "pods" => {
            let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
            let Ok(list) = api.list(&ListParams::default()).await else { return Vec::new() };
            list.items.iter().filter(|p| filter(&p.metadata, uid)).map(pair).collect()
        }
        "replicasets" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
            let Ok(list) = api.list(&ListParams::default()).await else { return Vec::new() };
            list.items.iter().filter(|r| filter(&r.metadata, uid)).map(pair).collect()
        }
        "statefulsets" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
            let Ok(list) = api.list(&ListParams::default()).await else { return Vec::new() };
            list.items.iter().filter(|s| filter(&s.metadata, uid)).map(pair).collect()
        }
        "daemonsets" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), namespace);
            let Ok(list) = api.list(&ListParams::default()).await else { return Vec::new() };
            list.items.iter().filter(|d| filter(&d.metadata, uid)).map(pair).collect()
        }
        "jobs" => {
            let api: Api<Job> = Api::namespaced(client.clone(), namespace);
            let Ok(list) = api.list(&ListParams::default()).await else { return Vec::new() };
            list.items.iter().filter(|j| filter(&j.metadata, uid)).map(pair).collect()
        }
        _ => Vec::new(),
    }
}

fn pair<K: ResourceExt + Clone>(obj: &K) -> (String, String) {
    (obj.namespace().unwrap_or_default(), obj.name_any())
}

/// Services in the namespace whose (non-empty) selector matches all the labels.
async fn services_selecting(
    client: &Client,
    namespace: &str,
    labels: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    let api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let Ok(list) = api.list(&ListParams::default()).await else { return Vec::new() };
    list.items
        .iter()
        .filter(|s| {
            let sel = s.spec.as_ref().and_then(|sp| sp.selector.as_ref());
            match sel {
                Some(sel) if !sel.is_empty() => sel.iter().all(|(k, v)| labels.get(k) == Some(v)),
                _ => false,
            }
        })
        .map(pair)
        .collect()
}

/// Ingresses in the namespace routing to the Service.
async fn ingresses_to_service(client: &Client, namespace: &str, service: &str) -> Vec<(String, String)> {
    let api: Api<Ingress> = Api::namespaced(client.clone(), namespace);
    let Ok(list) = api.list(&ListParams::default()).await else { return Vec::new() };
    list.items
        .iter()
        .filter(|ing| {
            let spec = ing.spec.as_ref();
            let default = spec
                .and_then(|s| s.default_backend.as_ref())
                .map(backend_service)
                .unwrap_or_default();
            let rules: Vec<String> = spec
                .map(|s| {
                    s.rules
                        .iter()
                        .flatten()
                        .flat_map(|r| {
                            r.http
                                .as_ref()
                                .map(|h| h.paths.iter().map(|p| backend_service(&p.backend)).collect::<Vec<_>>())
                                .unwrap_or_default()
                        })
                        .collect()
                })
                .unwrap_or_default();
            default == service || rules.contains(&service.to_string())
        })
        .map(pair)
        .collect()
}

fn backend_service(b: &IngressBackend) -> String {
    b.service.as_ref().map(|s| s.name.clone()).unwrap_or_default()
}

/// Fetch one object as a DynamicObject for its metadata.
async fn fetch(client: &Client, nav: &str, namespace: &str, name: &str) -> Option<DynamicObject> {
    let (group, version, kind, namespaced) = match nav {
        "pods" => ("", "v1", "Pod", true),
        "deployments" => ("apps", "v1", "Deployment", true),
        "replicasets" => ("apps", "v1", "ReplicaSet", true),
        "statefulsets" => ("apps", "v1", "StatefulSet", true),
        "daemonsets" => ("apps", "v1", "DaemonSet", true),
        "jobs" => ("batch", "v1", "Job", true),
        "services" => ("", "v1", "Service", true),
        "ingresses" => ("networking.k8s.io", "v1", "Ingress", true),
        _ => return None,
    };
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, kind), nav);
    let api: Api<DynamicObject> = if namespaced {
        Api::namespaced_with(client.clone(), namespace, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };
    api.get(name).await.ok()
}

/// The nav id for a Kubernetes Kind, for the kinds we can navigate to.
fn nav_for_kind(kind: &str) -> Option<&'static str> {
    crate::kube::properties::builtin_nav_id(kind)
}

fn node_key(nav: &str, namespace: &str, name: &str) -> String {
    format!("{nav}:{namespace}/{name}")
}

/// Add a node if unseen; returns whether it was new.
fn add_node(
    nodes: &mut Vec<TopologyNode>,
    seen: &mut HashSet<String>,
    nav: &str,
    kind: &str,
    namespace: &str,
    name: &str,
) -> bool {
    let id = node_key(nav, namespace, name);
    if !seen.insert(id.clone()) {
        return false;
    }
    nodes.push(TopologyNode {
        id,
        kind: kind.to_string(),
        namespace: namespace.to_string(),
        name: name.to_string(),
        nav: nav.to_string(),
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nodes are added once — the shared Deployment node in a Deployment → RS →
    /// Pod chain isn't duplicated when both the seed and an edge reach it.
    #[test]
    fn nodes_are_deduplicated_by_id() {
        let mut nodes = Vec::new();
        let mut seen = HashSet::new();
        assert!(add_node(&mut nodes, &mut seen, "deployments", "Deployment", "prod", "api"));
        assert!(!add_node(&mut nodes, &mut seen, "deployments", "Deployment", "prod", "api"));
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "deployments:prod/api");
        assert_eq!(nodes[0].nav, "deployments");
    }

    /// The owner/nav map covers the kinds the graph walks.
    #[test]
    fn nav_resolves_for_graph_kinds() {
        for (kind, nav) in [
            ("Deployment", "deployments"),
            ("ReplicaSet", "replicasets"),
            ("Pod", "pods"),
            ("Service", "services"),
            ("Ingress", "ingresses"),
            ("StatefulSet", "statefulsets"),
        ] {
            assert_eq!(nav_for_kind(kind), Some(nav));
        }
        // A kind we don't list has no navigable node.
        assert_eq!(nav_for_kind("CustomResourceDefinition"), None);
    }

    /// An Ingress backend's service name is what the reference edge keys on.
    #[test]
    fn backend_service_name_extraction() {
        let b: IngressBackend = serde_json::from_value(serde_json::json!({
            "service": { "name": "valkyrie-api", "port": { "number": 8080 } }
        }))
        .unwrap();
        assert_eq!(backend_service(&b), "valkyrie-api");
    }
}
