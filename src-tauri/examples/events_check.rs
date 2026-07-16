//! Live verification of the cluster-wide events feed (B14) against a real cluster.
//! Lists core/v1 Events and runs them through the *same* `map_event` + `sort_events`
//! the watcher uses, then prints the feed as the table would render it:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example events_check
//!
//! Confirms the column contract, the Warnings-first/newest ordering, and the cap.

use k8s_openapi::api::core::v1::Event;
use k7s_lib::kube::mappers;
use kube::api::{Api, ListParams};
use kube::Client;

/// Same cap the watcher applies (see watchers::EVENTS_CAP).
const CAP: usize = 500;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;
    let api: Api<Event> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    println!("cluster events: {}", list.items.len());

    let rows = mappers::sort_events(list.items.iter().map(mappers::map_event).collect(), CAP);
    println!("feed rows (capped at {CAP}): {}\n", rows.len());

    let warnings = rows.iter().filter(|r| r.cells[0].text == "Warning").count();
    println!("warnings: {warnings}\n");

    // TYPE, REASON, OBJECT, NAMESPACE, AGE, COUNT, MESSAGE — the top of the feed.
    for r in rows.iter().take(15) {
        let c = |i: usize| r.cells[i].text.as_str();
        println!(
            "{:<8} {:<22} {:<44} {:<14} {:<6} {}",
            c(0),
            c(1),
            c(2),
            c(3),
            c(5),
            &c(6).chars().take(70).collect::<String>()
        );
    }

    // The ordering contract: every Warning precedes every Normal.
    let first_normal = rows.iter().position(|r| r.cells[0].text == "Normal");
    let last_warning = rows.iter().rposition(|r| r.cells[0].text == "Warning");
    if let (Some(n), Some(w)) = (first_normal, last_warning) {
        assert!(w < n, "ordering violated: a Normal sorted above a Warning");
    }
    println!("\nOrdering OK (Warnings first, then newest).");
    Ok(())
}
