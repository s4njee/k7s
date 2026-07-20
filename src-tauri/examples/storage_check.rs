//! Live verification of the PersistentVolume / PersistentVolumeClaim tables
//! against a real cluster, through the same mappers the watchers use:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example storage_check
//!
//! Read-only. Renders both tables as the UI would and checks the two things the
//! column contract depends on: that a PV row is cluster-scoped (no namespace) and
//! that every claim/volume pair agrees — a bound PVC's VOLUME is a PV we listed,
//! and that PV's CLAIM points back at the claim.

use k7s_lib::kube::mappers::{map_pv, map_pvc};
use k8s_openapi::api::core::v1::{PersistentVolume, PersistentVolumeClaim};
use kube::api::{Api, ListParams};
use kube::Client;
use std::collections::HashMap;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- PersistentVolumeClaims ----
    let pvcs: Api<PersistentVolumeClaim> = Api::all(client.clone());
    let claims = pvcs.list(&ListParams::default()).await?;
    println!("PersistentVolumeClaims ({}):", claims.items.len());
    println!("  {:<26} {:<12} {:<8} {:<40} {:<9} {:<6} {:<10}", "NAME", "NAMESPACE", "STATUS", "VOLUME", "CAPACITY", "ACCESS", "CLASS");
    let mut claim_volume: HashMap<String, String> = HashMap::new();
    for p in &claims.items {
        let row = map_pvc(p);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<26} {:<12} {:<8} {:<40} {:<9} {:<6} {}", t(0), t(1), t(2), t(3), t(4), t(5), t(6));
        assert_eq!(row.cells.len(), 8, "PVC rows must fill the 8-column contract");
        assert!(row.namespace.is_some(), "a claim is namespaced");
        if t(2) == "Bound" {
            claim_volume.insert(format!("{}/{}", t(1), t(0)), t(3));
        }
    }

    // ---- PersistentVolumes ----
    let pvs: Api<PersistentVolume> = Api::all(client.clone());
    let volumes = pvs.list(&ListParams::default()).await?;
    println!("\nPersistentVolumes ({}):", volumes.items.len());
    println!("  {:<40} {:<9} {:<6} {:<8} {:<10} {:<34} {:<10}", "NAME", "CAPACITY", "ACCESS", "RECLAIM", "STATUS", "CLAIM", "CLASS");
    let mut volume_claim: HashMap<String, String> = HashMap::new();
    for v in &volumes.items {
        let row = map_pv(v);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<40} {:<9} {:<6} {:<8} {:<10} {:<34} {}", t(0), t(1), t(2), t(3), t(4), t(5), t(6));
        assert_eq!(row.cells.len(), 8, "PV rows must fill the 8-column contract");
        assert!(row.namespace.is_none(), "a volume is cluster-scoped — no namespace column");
        if t(4) == "Bound" {
            volume_claim.insert(t(0), t(5));
        }
    }

    // ---- the two views agree ----
    // Every bound claim names a volume we listed, and that volume names it back.
    let mut checked = 0;
    for (claim, volume) in &claim_volume {
        let back = volume_claim
            .get(volume)
            .unwrap_or_else(|| panic!("claim {claim} is bound to {volume}, which isn't in the PV list"));
        assert_eq!(back, claim, "PV {volume} must point back at {claim}");
        checked += 1;
    }
    println!("\n{checked} bound claim/volume pair(s) reference each other consistently.");
    assert!(checked > 0, "freya has bound claims to check");

    println!("\nStorage tables OK.");
    Ok(())
}
