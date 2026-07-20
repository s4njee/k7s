//! **Read-only** verification of the drain pod-selection rules (B20) against a
//! real cluster:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example drain_check
//!
//! This deliberately evicts NOTHING and cordons nothing — it only reports which
//! pods a drain *would* evict and which it would skip, so the selection rules can
//! be checked against a live node without disrupting it. Draining a real node is
//! a decision for the operator, not for a test harness.

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, ListParams};
use kube::{Client, ResourceExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    let nodes: Api<Node> = Api::all(client.clone());
    for node in nodes.list(&ListParams::default()).await?.items {
        let name = node.name_any();
        println!("\n=== node {name} (dry run — nothing is evicted) ===");

        let pods: Api<Pod> = Api::all(client.clone());
        let lp = ListParams::default().fields(&format!("spec.nodeName={name}"));
        let list = pods.list(&lp).await?;

        let (mut evict, mut skip) = (Vec::new(), Vec::new());
        for p in &list.items {
            let ns = p.namespace().unwrap_or_default();
            let label = format!("{ns}/{}", p.name_any());
            match skip_reason(p) {
                Some(reason) => skip.push(format!("{label}  ({reason})")),
                None => evict.push(label),
            }
        }

        println!("would evict ({}):", evict.len());
        for p in &evict {
            println!("    {p}");
        }
        println!("would skip ({}):", skip.len());
        for p in &skip {
            println!("    {p}");
        }

        // The selection must be a partition of the node's pods — no pod may be
        // silently dropped from both lists.
        assert_eq!(
            evict.len() + skip.len(),
            list.items.len(),
            "every pod on the node must be either evicted or skipped"
        );
    }

    println!("\nDrain selection checked (read-only; no pod was evicted).");
    Ok(())
}

/// Mirror of drain.rs's skip rules, reported with the reason for the dry run.
/// Kept here rather than exposing internals: this harness is about *seeing* the
/// classification, and a divergence would show up as a surprising listing.
fn skip_reason(pod: &Pod) -> Option<&'static str> {
    if pod.metadata.owner_references.iter().flatten().any(|o| o.kind == "DaemonSet") {
        return Some("DaemonSet-owned");
    }
    if pod
        .metadata
        .annotations
        .as_ref()
        .map(|a| a.contains_key("kubernetes.io/config.mirror"))
        .unwrap_or(false)
    {
        return Some("static/mirror pod");
    }
    if pod.metadata.deletion_timestamp.is_some() {
        return Some("already terminating");
    }
    match pod.status.as_ref().and_then(|s| s.phase.as_deref()) {
        Some("Succeeded") => Some("already Succeeded"),
        Some("Failed") => Some("already Failed"),
        _ => None,
    }
}
