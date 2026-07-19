//! Live verification of the Helm releases view (B26) against a real cluster,
//! through the same decode/reduce the watcher uses:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example helm_check
//!
//! Lists releases as the table would show them, and checks the two things the
//! storage format makes easy to get wrong: one row per release (not per revision
//! Secret), and no Secret values leaking through a rendered manifest.

use k7s_lib::kube::helm;
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use kube::Client;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;
    let api: Api<Secret> = Api::all(client);
    let lp = ListParams::default().fields(&format!("type={}", helm::RELEASE_SECRET_TYPE));
    let secrets = api.list(&lp).await?.items;
    println!("release secrets on the cluster: {}", secrets.len());

    // The watcher's exact path: map each Secret, then reduce to newest-per-release.
    let rows: Vec<_> = secrets.iter().filter_map(helm::map_release).collect();
    println!("decoded rows: {}", rows.len());
    let table = helm::latest_only(rows);

    println!("\nNAME                 NAMESPACE       CHART                          APP VERSION  REV  STATUS");
    for r in &table {
        let c = |i: usize| r.cells[i].text.clone();
        println!(
            "{:<20} {:<15} {:<30} {:<12} {:<4} {}",
            c(0),
            c(1),
            c(2),
            c(3),
            c(4),
            c(5)
        );
    }

    // Every release must appear exactly once, whatever its revision count.
    let mut ids: Vec<String> = table.iter().map(|r| r.uid.clone()).collect();
    let before = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(before, ids.len(), "a release must not appear twice");

    // The backlog's own acceptance target.
    assert!(
        table.iter().any(|r| r.name == "traefik"),
        "freya runs traefik via helm; it should be listed"
    );

    // Manifests: readable, and with nothing secret in them.
    println!("\n--- manifests ---");
    for s in &secrets {
        let Some(rel) = helm::decode_release(s) else { continue };
        let secret_docs = rel.manifest.matches("kind: Secret").count();
        println!(
            "{:<20} manifest {:>6} bytes, {} Secret document(s)",
            rel.name,
            rel.manifest.len(),
            secret_docs
        );
        if secret_docs > 0 {
            assert!(
                rel.manifest.contains("<redacted>"),
                "{}: a rendered Secret must have its values redacted",
                rel.name
            );
            println!("    ↳ values redacted ✓");
        }
    }

    println!("\nHelm releases OK.");
    Ok(())
}
