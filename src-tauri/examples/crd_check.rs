//! Live verification of CRD discovery + dynamic watching (B15) against a real
//! cluster, using the same code paths the app uses:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example crd_check
//!
//! Lists discovered custom kinds, lists objects of a few of them through the same
//! DynamicObject API the lazy watchers use, then drives a real reflector-backed
//! watcher for one kind and prints the rows exactly as the table would show them.
//!
//! Discovery-based (B45): fixtures are whatever CRDs the cluster has. A cluster
//! with no CRDs — or none that hold objects — prints an explicit skip rather
//! than failing, so the harness runs on a fresh kind cluster too.

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
    if kinds.is_empty() {
        println!("\nno custom kinds on this cluster, skipping");
        k7s_lib::harness::skip("no custom kinds on this cluster");
        return Ok(());
    }

    // List each kind's objects so the spot-check below and the reflector watch
    // below can pick kinds that actually hold something. Cluster-wide either way
    // — the watchers list across all namespaces and let the frontend's namespace
    // filter narrow it.
    let mut with_objects: Vec<(String, usize)> = Vec::new();
    for k in &kinds {
        let ar = k.api_resource();
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        match api.list(&ListParams::default()).await {
            Ok(list) => with_objects.push((k.id.clone(), list.items.len())),
            // RBAC can deny listing a specific kind; it isn't a reason to fail.
            Err(e) => println!("{}: ERROR listing: {e}", k.id),
        }
    }

    // Spot-check the kinds that hold objects (whatever they are).
    println!("\n--- listing objects via DynamicObject ---");
    for (id, _) in with_objects.iter().take(3) {
        let k = kinds.iter().find(|k| &k.id == id).unwrap();
        let ar = k.api_resource();
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        match api.list(&ListParams::default()).await {
            Ok(list) => {
                println!("{id}: {} objects", list.items.len());
                for o in list.items.iter().take(3) {
                    println!(
                        "    {}/{}",
                        o.metadata.namespace.clone().unwrap_or_else(|| "-".into()),
                        o.metadata.name.clone().unwrap_or_default()
                    );
                }
            }
            Err(e) => println!("{id}: ERROR {e}"),
        }
    }

    // Drive the same reflector-backed dynamic watcher the app spawns lazily, on
    // the first kind that actually holds objects, and map its store through
    // map_dynamic — this is what the table renders.
    let Some((target_id, _)) = with_objects.first() else {
        println!("\nno custom kind holds objects on this cluster, skipping the watcher");
        k7s_lib::harness::skip("no custom kind holds objects");
        return Ok(());
    };
    let target = kinds.iter().find(|k| &k.id == target_id).unwrap();
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
    let columns = target.printer_columns.clone();
    let rows: Vec<_> = reader
        .state()
        .iter()
        .map(|o| mappers::map_dynamic(o.as_ref(), namespaced, &columns))
        .collect();
    let headers: Vec<String> = std::iter::once("NAME".into())
        .chain(columns.iter().map(|c| c.name.clone()))
        .chain(std::iter::once("AGE".into()))
        .collect();
    println!("watcher produced {} rows (columns {headers:?}):", rows.len());
    for r in &rows {
        let c: Vec<&str> = r.cells.iter().map(|c| c.text.as_str()).collect();
        println!("    {c:?}");
    }
    assert!(!rows.is_empty(), "the reflector must see the objects the list found");
    println!("\nDynamic watcher OK.");
    Ok(())
}
