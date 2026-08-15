//! Live verification of the topology graph (B55) against a real cluster:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example topology_check
//!
//! Discovers a Deployment (preferring one with a Service and Ingress, like the
//! fixture's valkyrie-api), builds its neighborhood graph with the same code
//! the Topology tab uses, and prints nodes + edges so the ownership/reference
//! chain can be eyeballed.

use k7s_lib::kube::topology;
use k8s_openapi::api::apps::v1::Deployment;
use kube::api::{Api, DynamicObject, ListParams};
use kube::core::{ApiResource, GroupVersionKind};
use kube::{Client, ResourceExt};

fn api_resource(kind: &str) -> ApiResource {
    let (g, v, k) = ("apps", "v1", "Deployment");
    ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(g, v, k), kind)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // Discover a Deployment in any namespace, preferring one with a service.
    let deps: Api<Deployment> = Api::all(client.clone());
    let list = deps.list(&ListParams::default()).await?;
    let Some(target) = list
        .items
        .iter()
        .find(|d| d.metadata.labels.as_ref().map(|l| l.contains_key("app")).unwrap_or(false))
        .or_else(|| list.items.first())
    else {
        println!("no Deployment on this cluster, skipping");
        k7s_lib::harness::skip("no Deployment on this cluster");
        return Ok(());
    };
    let ns = target.namespace().unwrap_or_default();
    let name = target.name_any();

    // Fetch the seed as the command does, and build the graph.
    let ar = api_resource("deployments");
    let seed_api: Api<DynamicObject> = Api::namespaced_with(client.clone(), &ns, &ar);
    let seed = seed_api.get(&name).await?;
    let seed_kind = seed.types.as_ref().map(|t| t.kind.clone()).unwrap_or_default();
    let topo = topology::build(&client, &ns, &seed_kind, &seed).await?;

    println!("topology of {ns}/{name} ({} nodes, {} edges):", topo.nodes.len(), topo.edges.len());
    for n in &topo.nodes {
        println!("  {:<10} {}", n.kind, n.name);
    }
    for e in &topo.edges {
        let from = topo.nodes.iter().find(|n| n.id == e.from).map(|n| &n.name).unwrap_or(&e.from);
        let to = topo.nodes.iter().find(|n| n.id == e.to).map(|n| &n.name).unwrap_or(&e.to);
        println!("  {from} --{}--> {to}", if e.rel == "ownership" { "─" } else { "-" });
    }

    assert!(!topo.nodes.is_empty(), "the seed is always a node");
    println!("\nTopology OK.");
    Ok(())
}
