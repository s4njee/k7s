//! Live verification of the Helm write path (B81) — rollback and uninstall —
//! against the fixture cluster:
//!
//!   ./dev/cluster/helm-fixture.sh               # installs fixture-app rev1 (red) + rev2 (blue)
//!   KUBECONFIG=... cargo run --example helm_write_check
//!
//! **Writes to the cluster** (the harness, not a dry run): it rolls fixture-app
//! back one revision and then uninstalls it, so after the run the fixture has no
//! release — re-run helm-fixture.sh to restore. It operates **only** on the
//! release named `fixture-app`, never a broad sweep.
//!
//! This is the interop proof: the new revision Secret must read back exactly as
//! `helm history` / `helm get manifest` would, and the previously-deployed
//! revision must flip to superseded — both verified against a real Helm 4.2.3
//! rollback's output.

use k7s_lib::kube::helm;
use k8s_openapi::api::core::v1::{ConfigMap, Secret};
use kube::api::{Api, ListParams};
use kube::Client;

const RELEASE: &str = "fixture-app";
const NS: &str = "prod";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- find the release and its revisions ----
    let api: Api<Secret> = Api::namespaced(client.clone(), NS);
    let lp = ListParams::default().labels(&format!("owner=helm,name={RELEASE}"));
    let secrets = api.list(&lp).await?;
    assert!(secrets.items.len() >= 2, "fixture-app needs ≥2 revisions — run dev/cluster/helm-fixture.sh");
    let mut payloads: Vec<_> = secrets.items.iter().filter_map(helm::raw_release).collect();
    payloads.sort_by_key(|v| v["version"].as_i64().unwrap_or(0));
    let max = payloads.last().unwrap()["version"].as_i64().unwrap();
    let target = max - 1;
    let target_manifest = payloads.iter().find(|v| v["version"].as_i64() == Some(target))
        .unwrap()["manifest"].as_str().unwrap_or_default().to_string();
    println!("fixture-app is at revision {max}; rolling back to {target}");

    // ---- rollback ----
    let new_rev = helm::rollback(client.clone(), NS, RELEASE, target).await?;
    assert_eq!(new_rev, max + 1, "rollback writes the next revision");

    let new_name = format!("sh.helm.release.v1.{RELEASE}.v{new_rev}");
    let new_secret = api.get(&new_name).await?;
    let payload = helm::raw_release(&new_secret).expect("new revision decodes");
    assert_eq!(payload["version"].as_i64(), Some(new_rev));
    assert_eq!(payload["info"]["status"], "deployed");
    assert_eq!(payload["info"]["description"], format!("Rollback to {target}"));
    assert_eq!(payload["manifest"].as_str().unwrap_or_default(), target_manifest,
        "the new revision's manifest is the target's, verbatim (helm copies it)");
    let labels = new_secret.metadata.labels.as_ref().expect("labels");
    assert_eq!(labels.get("status").map(String::as_str), Some("deployed"));
    assert_eq!(labels.get("version").map(String::as_str), Some(new_rev.to_string().as_str()));
    println!("new revision {new_rev}: deployed, \"Rollback to {target}\", manifest == rev{target}");

    // The previously-deployed revision flipped to superseded (label at least;
    // the payload too — helm history reads the label-first shape either way).
    let old = api.get(&format!("sh.helm.release.v1.{RELEASE}.v{max}")).await?;
    assert_eq!(old.metadata.labels.as_ref().unwrap().get("status").map(String::as_str), Some("superseded"));
    assert_eq!(helm::raw_release(&old).unwrap()["info"]["status"], "superseded");
    println!("revision {max} marked superseded");

    // The cluster reflects the target: rev1's ConfigMap has color=red.
    let cms: Api<ConfigMap> = Api::namespaced(client.clone(), NS);
    let cm = cms.get(&format!("{RELEASE}-config")).await?;
    let color = cm.data.as_ref().and_then(|d| d.get("color")).cloned();
    println!("ConfigMap color after rollback: {color:?}");
    assert_eq!(color.as_deref(), Some("red"), "the rollback applied the target's manifest");

    // ---- uninstall ----
    let outcome = helm::uninstall(client.clone(), NS, RELEASE).await?;
    println!(
        "uninstalled: {} object(s), {} secret(s) deleted",
        outcome.objects_deleted, outcome.secrets_deleted
    );
    assert!(outcome.objects_deleted >= 2, "the ConfigMap and Deployment were both deleted");
    assert!(outcome.secrets_deleted >= 2, "both revision Secrets were deleted");
    assert!(api.list(&lp).await?.items.is_empty(), "no revision Secrets remain");
    assert!(cms.get(&format!("{RELEASE}-config")).await.is_err(), "the ConfigMap is gone");

    println!("\nHelm write path OK (fixture left without a release — re-run dev/cluster/helm-fixture.sh to restore).");
    Ok(())
}
