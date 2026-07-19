//! Live verification of CRD discovery + dynamic watching (B15) against a real
//! cluster, using the same code paths the app uses:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example crd_check
//!
//! Lists discovered custom kinds, lists objects of a few of them through the same
//! DynamicObject API the lazy watchers use, then drives a real reflector-backed
//! watcher for one kind and prints the rows exactly as the table would show them.

use futures::StreamExt;
use k7s_lib::kube::{discovery, mappers};
use kube::api::{Api, ListParams};
use kube::core::DynamicObject;
use kube::runtime::{reflector, watcher, WatchStreamExt};
use kube::Client;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    let kinds = discovery::discover(&client).await;
    println!("discovered custom kinds: {}\n", kinds.len());
    for k in &kinds {
        println!(
            "{:<48} {:<22} {:<10} {}",
            k.id,
            k.kind,
            k.version,
            if k.namespaced { "namespaced" } else { "cluster" }
        );
    }

    // Spot-check the kinds the backlog names, plus whatever else is present.
    println!("\n--- listing objects via DynamicObject ---");
    for k in kinds.iter().filter(|k| {
        k.id.starts_with("argoproj.io/applications")
            || k.id.starts_with("traefik")
            || k.id.starts_with("helm.cattle.io")
    }) {
        let ar = k.api_resource();
        // Cluster-wide either way — the watchers list across all namespaces and
        // let the frontend's namespace filter narrow it.
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        match api.list(&ListParams::default()).await {
            Ok(list) => {
                println!("{}: {} objects", k.id, list.items.len());
                for o in list.items.iter().take(3) {
                    println!(
                        "    {}/{}",
                        o.metadata.namespace.clone().unwrap_or_else(|| "-".into()),
                        o.metadata.name.clone().unwrap_or_default()
                    );
                }
            }
            Err(e) => println!("{}: ERROR {e}", k.id),
        }
    }

    // Drive the same reflector-backed dynamic watcher the app spawns lazily, and
    // map its store through map_dynamic — this is what the table renders.
    let target = kinds
        .iter()
        .find(|k| k.id == "argoproj.io/applications")
        .expect("freya has Argo CD Applications");
    println!("\n--- watching {} via reflector ---", target.id);

    let ar = target.api_resource();
    let api: Api<DynamicObject> = Api::all_with(client, &ar);
    let writer = reflector::store::Writer::<DynamicObject>::new(ar.clone());
    let reader = writer.as_reader();
    let mut stream = reflector(writer, watcher(api, watcher::Config::default()))
        .default_backoff()
        .boxed();

    // Pump until the initial list has been applied to the store.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout_at(deadline, stream.next()).await {
            Ok(Some(Ok(_))) => {
                if !reader.state().is_empty() {
                    break;
                }
            }
            Ok(Some(Err(e))) => println!("watch error: {e}"),
            _ => break,
        }
    }

    let namespaced = target.namespaced;
    let rows: Vec<_> = reader
        .state()
        .iter()
        .map(|o| mappers::map_dynamic(o.as_ref(), namespaced))
        .collect();
    println!("watcher produced {} rows (columns NAME, NAMESPACE, AGE):", rows.len());
    for r in &rows {
        let c: Vec<&str> = r.cells.iter().map(|c| c.text.as_str()).collect();
        println!("    {c:?}");
    }
    assert!(!rows.is_empty(), "expected the reflector to see live Applications");
    println!("\nDynamic watcher OK.");
    Ok(())
}
