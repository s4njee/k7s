//! Live verification of related-resource navigation (B33) against a real cluster,
//! using the same mappers and `resolve_owner` the app uses:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example related_check
//!
//! Read-only. Checks the three jumps' backing data actually exists on freya:
//!   - pods carry labels and a Deployment carries a selector that *matches* them
//!     (the "view pods" jump),
//!   - a crash-looping pod's owner resolves through its ReplicaSet to its
//!     Deployment (the owner link),
//!   - a real Event carries its involvedObject kind/name/namespace (event
//!     click-through).

use k7s_lib::kube::mappers::{map_deployment, map_event, map_pod};
use k7s_lib::kube::properties::resolve_owner;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, ListParams};
use kube::{Client, ResourceExt};

/// Render a selector map as the `k=v,k2=v2` filter string the UI drops into the box.
fn selector_filter(sel: &std::collections::BTreeMap<String, String>) -> String {
    let mut keys: Vec<_> = sel.keys().cloned().collect();
    keys.sort();
    keys.iter().map(|k| format!("{k}={}", sel[k])).collect::<Vec<_>>().join(",")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- workload → pods: a Deployment's selector matches its pods' labels ----
    let deploys: Api<Deployment> = Api::all(client.clone());
    let dl = deploys.list(&ListParams::default()).await?;
    // Pick a Deployment that actually declares a selector and has replicas.
    let dep = dl
        .items
        .iter()
        .find(|d| {
            d.spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.as_ref())
                .is_some_and(|m| !m.is_empty())
        })
        .expect("a Deployment with a selector");
    let dep_ns = dep.namespace().unwrap_or_default();
    let dep_row = map_deployment(dep);
    let sel = dep_row.selector.clone().expect("map_deployment carries the selector");
    let filter = selector_filter(&sel);
    println!("workload → pods:");
    println!("  Deployment {}/{}  selector: {filter}", dep_ns, dep.name_any());

    // Now confirm pods in that namespace carry labels, and that the selector
    // actually selects some — the jump would land on an empty table otherwise.
    let pods_ns: Api<Pod> = Api::namespaced(client.clone(), &dep_ns);
    let pods = pods_ns.list(&ListParams::default()).await?;
    let matched = pods
        .items
        .iter()
        .filter(|p| {
            let row = map_pod(p);
            row.labels
                .as_ref()
                .is_some_and(|labels| sel.iter().all(|(k, v)| labels.get(k) == Some(v)))
        })
        .count();
    let with_labels = pods.items.iter().filter(|p| map_pod(p).labels.is_some()).count();
    println!("  pods in {dep_ns}: {} total, {with_labels} carry labels, {matched} match the selector", pods.items.len());
    assert!(with_labels > 0, "pods must carry labels for the filter to match");
    assert!(matched > 0, "the selector must select at least one pod, or the jump lands empty");

    // ---- owner link: a crash-looper resolves through its RS to its Deployment ----
    let wiki: Api<Pod> = Api::namespaced(client.clone(), "wiki");
    let wpods = wiki.list(&ListParams::default()).await?;
    if let Some(p) = wpods.items.iter().max_by_key(|p| {
        p.status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .map(|cs| cs.iter().map(|c| c.restart_count).sum::<i32>())
            .unwrap_or(0)
    }) {
        let (text, nav) = resolve_owner(&client, "wiki", p).await;
        println!("\nowner link:");
        println!("  pod wiki/{}  →  owner \"{text}\"", p.name_any());
        match &nav {
            Some(t) => println!("  nav target: kind={} ns={:?} name={}", t.kind, t.namespace, t.name),
            None => println!("  nav target: none (bare pod or non-listed owner)"),
        }
        // The crash-looper is Deployment-managed, so it resolves through the RS.
        if let Some(t) = nav {
            assert_eq!(t.kind, "deployments", "a Deployment-owned pod resolves to the deployments table");
            assert!(text.starts_with("Deployment/"), "display shows the resolved Deployment");
        }
    }

    // ---- event click-through: a real event carries its involvedObject ----
    let events: Api<Event> = Api::all(client.clone());
    let evs = events.list(&ListParams::default().limit(200)).await?;
    let with_involved = evs.items.iter().filter(|e| map_event(e).involved.is_some()).count();
    println!("\nevent click-through:");
    println!("  {} events, {with_involved} carry an involvedObject", evs.items.len());
    if let Some(e) = evs.items.iter().find(|e| map_event(e).involved.is_some()) {
        let inv = map_event(e).involved.unwrap();
        println!("  e.g. {} {}/{} ({})", inv.kind, inv.namespace.as_deref().unwrap_or("-"), inv.name, inv.api_version.as_deref().unwrap_or("-"));
    }
    assert!(with_involved > 0, "events must carry involvedObject for click-through");

    println!("\nRelated-navigation data OK.");
    Ok(())
}
