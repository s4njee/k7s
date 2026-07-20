//! Live verification of the properties gatherers (B13, B18) against a real
//! cluster, calling the same `properties::gather` the command calls:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example properties_check
//!
//! Prints each kind's rendered sections, so the column contract and the values
//! can be eyeballed against the cluster, and asserts the sections the backlog
//! names actually appear (ReplicaSets + conditions for Deployments, endpoints for
//! Services, taints + capacity for Nodes).

use k7s_lib::kube::properties::{self, Body, Properties};
use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Node, Pod, Service};
use kube::api::{Api, ListParams};
use kube::{Client, ResourceExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // Pick a real object of each kind rather than hard-coding names.
    let pod = first_named::<Pod>(&client).await;
    let dep = first_named::<Deployment>(&client).await;
    let svc = Api::<Service>::namespaced(client.clone(), "argocd")
        .get_opt("argocd-server")
        .await?
        .map(|s| ("argocd".to_string(), s.name_any()));
    let sts = first_named::<StatefulSet>(&client).await;
    let node = Api::<Node>::all(client.clone())
        .list(&ListParams::default().limit(1))
        .await?
        .items
        .first()
        .map(|n| (String::new(), n.name_any()));

    for (kind, target) in [
        ("pods", pod),
        ("deployments", dep),
        ("services", svc),
        ("statefulsets", sts),
        ("nodes", node),
    ] {
        let Some((ns, name)) = target else {
            println!("\n=== {kind}: none on this cluster, skipping ===");
            continue;
        };
        println!("\n=== {kind}: {ns}/{name} ===");
        match properties::gather(client.clone(), kind, &ns, &name).await {
            Ok(props) => {
                print_props(&props);
                check(kind, &props);
            }
            Err(e) => panic!("{kind} properties failed: {e}"),
        }
    }

    // A kind with no gatherer must error, so the tab is never offered for it.
    assert!(
        properties::gather(client, "configmaps", "default", "x").await.is_err(),
        "kinds without a gatherer must error"
    );

    println!("\nAll properties checks passed.");
    Ok(())
}

/// The first object of kind `K` in the cluster, as (namespace, name).
async fn first_named<K>(client: &Client) -> Option<(String, String)>
where
    K: kube::Resource<DynamicType = ()> + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
{
    let api: Api<K> = Api::all(client.clone());
    let list = api.list(&ListParams::default().limit(1)).await.ok()?;
    let obj = list.items.into_iter().next()?;
    Some((obj.namespace().unwrap_or_default(), obj.name_any()))
}

/// Print a properties document roughly as the tab lays it out.
fn print_props(props: &Properties) {
    for s in &props.sections {
        match &s.body {
            Body::Fields { fields } => {
                println!("  [{}]", s.title);
                for f in fields {
                    println!("      {:<18} {}", f.label, f.value.text);
                }
            }
            Body::Table { columns, rows } => {
                println!("  [{}] ({})", s.title, rows.len());
                if rows.is_empty() {
                    println!("      — {}", s.empty_note.clone().unwrap_or_default());
                } else {
                    println!("      {}", columns.join(" | "));
                    for r in rows.iter().take(6) {
                        let cells: Vec<String> = r
                            .iter()
                            .map(|c| c.text.chars().take(38).collect::<String>())
                            .collect();
                        println!("      {}", cells.join(" | "));
                    }
                }
            }
            Body::Chips { chips } => {
                println!("  [{}] ({})", s.title, chips.len());
                for kv in chips.iter().take(4) {
                    println!("      {}={}", kv.key, kv.value);
                }
            }
        }
    }
}

/// True when a section with this title exists.
fn has(props: &Properties, title: &str) -> bool {
    props.sections.iter().any(|s| s.title == title)
}

/// Assert the sections the backlog's accept criteria name for each kind.
fn check(kind: &str, props: &Properties) {
    assert!(has(props, "Overview"), "{kind} should always have an Overview");
    match kind {
        "deployments" => {
            assert!(has(props, "ReplicaSets"), "deployment properties must show ReplicaSets");
            assert!(has(props, "Conditions"), "deployment properties must show conditions");
        }
        "services" => {
            assert!(has(props, "Endpoints"), "service properties must list endpoints");
            assert!(has(props, "Ports"));
        }
        "nodes" => {
            assert!(has(props, "Taints"), "node properties must show taints");
            assert!(has(props, "Capacity"), "node properties must show capacity/allocatable");
            assert!(has(props, "Conditions"));
        }
        "statefulsets" => assert!(has(props, "Volume claim templates") || has(props, "Conditions")),
        "pods" => assert!(has(props, "Containers")),
        _ => {}
    }
}
