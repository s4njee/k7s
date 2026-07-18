//! Live verification of the reference links (B40) against a real cluster:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example related_links_check
//!
//! Read-only. The point of B40 was that references the UI renders should be
//! *openable*, so this checks the links rather than just the new tables: it
//! gathers a real pod's properties and asserts every nav target it produces
//! points at an object that actually exists, resolving each one against the API.
//! A link to a 404 would be worse than the plain text it replaced.

use k7s_lib::kube::mappers::{map_replicaset, map_storageclass};
use k7s_lib::kube::dto::NavTarget;
use k7s_lib::kube::properties::{gather, Body};
use k8s_openapi::api::apps::v1::ReplicaSet;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::api::storage::v1::StorageClass;
use kube::api::{Api, ApiResource, DynamicObject, ListParams};
use kube::core::GroupVersionKind;
use kube::{Client, ResourceExt};

/// The GVK behind each nav id we can emit, for resolving a target back to a real
/// object. Mirrors `resource_for` in commands.rs.
fn gvk_for(kind: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match kind {
        "pods" => ("", "v1", "Pod"),
        "services" => ("", "v1", "Service"),
        "serviceaccounts" => ("", "v1", "ServiceAccount"),
        "ingressclasses" => ("networking.k8s.io", "v1", "IngressClass"),
        "configmaps" => ("", "v1", "ConfigMap"),
        "secrets" => ("", "v1", "Secret"),
        "persistentvolumeclaims" => ("", "v1", "PersistentVolumeClaim"),
        "persistentvolumes" => ("", "v1", "PersistentVolume"),
        "storageclasses" => ("storage.k8s.io", "v1", "StorageClass"),
        "nodes" => ("", "v1", "Node"),
        "deployments" => ("apps", "v1", "Deployment"),
        "replicasets" => ("apps", "v1", "ReplicaSet"),
        "statefulsets" => ("apps", "v1", "StatefulSet"),
        _ => return None,
    })
}

/// Resolve a nav target against the API — does the thing we'd navigate to exist?
async fn resolves(client: &Client, t: &NavTarget) -> bool {
    let Some((g, v, k)) = gvk_for(&t.kind) else { return false };
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(g, v, k), &t.kind);
    let api: Api<DynamicObject> = match &t.namespace {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };
    api.get(&t.name).await.is_ok()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- the two new tables ----
    let rss: Api<ReplicaSet> = Api::all(client.clone());
    let rs_list = rss.list(&ListParams::default()).await?;
    let live = rs_list.items.iter().filter(|r| r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0) > 0).count();
    println!("ReplicaSets: {} total, {live} with desired > 0 ({} superseded generations)", rs_list.items.len(), rs_list.items.len() - live);
    for r in rs_list.items.iter().take(3) {
        let row = map_replicaset(r);
        println!("  {:<44} {:>3} {:>3} {:>3}", row.name, row.cells[2].text, row.cells[3].text, row.cells[4].text);
    }
    assert_eq!(map_replicaset(&rs_list.items[0]).cells.len(), 6);

    let scs: Api<StorageClass> = Api::all(client.clone());
    let sc_list = scs.list(&ListParams::default()).await?;
    println!("\nStorageClasses ({}):", sc_list.items.len());
    for s in &sc_list.items {
        let row = map_storageclass(s);
        println!("  {:<24} {:<26} {:<8} {}", row.cells[0].text, row.cells[1].text, row.cells[2].text, row.cells[3].text);
        assert!(row.namespace.is_none(), "StorageClasses are cluster-scoped");
    }
    assert!(
        sc_list.items.iter().any(|s| s.metadata.annotations.as_ref()
            .and_then(|a| a.get("storageclass.kubernetes.io/is-default-class")).is_some_and(|v| v == "true")),
        "freya's local-path is the default class"
    );

    // ---- every link a real pod's properties emit must resolve ----
    // Prefer a pod with volumes, since that's where most references live.
    let pods: Api<Pod> = Api::all(client.clone());
    let all = pods.list(&ListParams::default()).await?;
    let target = all
        .items
        .iter()
        .max_by_key(|p| p.spec.as_ref().map(|s| s.volumes.as_ref().map(|v| v.len()).unwrap_or(0)).unwrap_or(0))
        .expect("the cluster has pods");
    let ns = target.namespace().unwrap_or_default();
    println!("\nchecking every link the properties panels emit:");

    let mut checked = 0usize;
    let mut broken = Vec::new();

    // Every gatherer that emits links, not just the pod panel: the Service and
    // StatefulSet tables were wired later and are easy to leave behind.
    let mut panels: Vec<(&str, String, String)> =
        vec![("pods", ns.clone(), target.name_any())];
    if let Some(s) = Api::<k8s_openapi::api::core::v1::Service>::all(client.clone())
        .list(&ListParams::default())
        .await?
        .items
        .into_iter()
        .find(|s| s.spec.as_ref().and_then(|sp| sp.selector.as_ref()).is_some())
    {
        panels.push(("services", s.namespace().unwrap_or_default(), s.name_any()));
    }
    // Prefer a StatefulSet that actually declares storage — its claim/volume/class
    // links are the ones worth checking, and a StatefulSet without templates
    // exercises none of them.
    let stss = Api::<k8s_openapi::api::apps::v1::StatefulSet>::all(client.clone())
        .list(&ListParams::default())
        .await?
        .items;
    let with_storage = stss.iter().find(|s| {
        s.spec
            .as_ref()
            .and_then(|sp| sp.volume_claim_templates.as_ref())
            .is_some_and(|t| !t.is_empty())
    });
    if let Some(s) = with_storage.or_else(|| stss.first()) {
        panels.push(("statefulsets", s.namespace().unwrap_or_default(), s.name_any()));
    }
    if let Some(i) = Api::<k8s_openapi::api::networking::v1::Ingress>::all(client.clone())
        .list(&ListParams::default())
        .await?
        .items
        .into_iter()
        .next()
    {
        panels.push(("ingresses", i.namespace().unwrap_or_default(), i.name_any()));
    }

    for (kind, pns, pname) in &panels {
    let props = gather(client.clone(), kind, pns, pname).await?;
    println!("  -- {kind} {pns}/{pname}");
    for section in &props.sections {
        match &section.body {
            Body::Fields { fields } => {
                for f in fields {
                    if let Some(t) = &f.nav {
                        let ok = resolves(&client, t).await;
                        println!("  [{}] {:<16} → {} {} {}", section.title, f.label, t.kind, t.name, if ok { "✓" } else { "✗" });
                        checked += 1;
                        if !ok { broken.push(format!("{}/{}", t.kind, t.name)); }
                    }
                }
            }
            Body::Table { rows, .. } => {
                for row in rows {
                    for cell in row {
                        if let Some(t) = &cell.nav {
                            let ok = resolves(&client, t).await;
                            println!("  [{}] {:<16} → {} {} {}", section.title, cell.text, t.kind, t.name, if ok { "✓" } else { "✗" });
                            checked += 1;
                            if !ok { broken.push(format!("{}/{}", t.kind, t.name)); }
                        }
                    }
                }
            }
            Body::Chips { .. } => {}
        }
    }
    }

    println!("\n{checked} link(s) checked, {} broken", broken.len());
    assert!(checked > 0, "the pod panel must emit some links, or B40 did nothing");
    assert!(broken.is_empty(), "every link must resolve; broken: {broken:?}");

    println!("\nReference links OK.");
    Ok(())
}
