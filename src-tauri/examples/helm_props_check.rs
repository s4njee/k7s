//! Live verification of Helm release detail (B35) against a real cluster, through
//! the same `properties::gather` the get_properties command calls:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example helm_props_check
//!
//! Read-only. For each release on the cluster it gathers the Overview / History /
//! Values document and prints it, checking that history is reconstructed from the
//! revision Secrets and that no value under a credential key is present in the
//! rendered Values.

use k7s_lib::kube::helm::{decode_release, RELEASE_SECRET_TYPE};
use k7s_lib::kube::properties::{gather, Body};
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use kube::Client;
use std::collections::BTreeSet;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // Discover the releases: one entry per (namespace, name), from the revision
    // Secrets. Decode gives us the release's own namespace/name.
    let secrets: Api<Secret> = Api::all(client.clone());
    let all = secrets.list(&ListParams::default()).await?;
    let mut releases: BTreeSet<(String, String)> = BTreeSet::new();
    for s in &all.items {
        if s.type_.as_deref() == Some(RELEASE_SECRET_TYPE) {
            if let Some(r) = decode_release(s) {
                releases.insert((r.namespace, r.name));
            }
        }
    }
    println!("found {} Helm release(s)\n", releases.len());
    assert!(!releases.is_empty(), "freya has Helm releases (traefik, arc, …)");

    for (ns, name) in &releases {
        let props = gather(client.clone(), "helm", ns, name).await?;
        println!("── {ns}/{name} ──");

        for section in &props.sections {
            match &section.body {
                Body::Fields { fields } => {
                    println!("  [{}]", section.title);
                    for f in fields {
                        println!("    {:<16} {}", f.label, f.value.text);
                    }
                }
                Body::Table { columns, rows } => {
                    println!("  [{}] {} row(s), cols: {}", section.title, rows.len(), columns.join(", "));
                    for row in rows.iter().take(6) {
                        let line: Vec<_> = row.iter().map(|c| c.text.as_str()).collect();
                        println!("    {}", line.join("  |  "));
                    }
                    // The security check: no value in the Values table is a raw
                    // credential — a redacted key shows the placeholder, not the value.
                    if section.title == "Values" {
                        for row in rows {
                            let key = row[0].text.to_lowercase();
                            let is_sensitive = ["password", "secret", "token", "key"]
                                .iter()
                                .any(|p| key.contains(p));
                            if is_sensitive {
                                assert_eq!(
                                    row[1].text, "<redacted>",
                                    "a credential value must render <redacted>, got {:?}",
                                    row[1].text
                                );
                            }
                        }
                    }
                }
                Body::Chips { chips } => {
                    println!("  [{}] {} chip(s)", section.title, chips.len());
                }
            }
        }

        // Every release must show an Overview and a History with at least its
        // current revision.
        let has_overview = props.sections.iter().any(|s| s.title == "Overview");
        let history_rows = props.sections.iter().find(|s| s.title == "History").map(|s| match &s.body {
            Body::Table { rows, .. } => rows.len(),
            _ => 0,
        });
        assert!(has_overview, "{ns}/{name} must have an Overview");
        assert!(history_rows.unwrap_or(0) >= 1, "{ns}/{name} history must include its current revision");
        println!();
    }

    println!("Helm release detail OK.");
    Ok(())
}
