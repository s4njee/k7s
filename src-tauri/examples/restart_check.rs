//! Live verification of the restart logic (B34) against a real cluster, using the
//! same `restart::has_controller` and `restart::restart_patch` the commands use:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example restart_check
//!
//! Checks the two decisions restart_pod/restart_rollout hinge on, and does so
//! *without mutating anything*:
//!   - `has_controller` is true for a Deployment/StatefulSet-managed pod (so a
//!     restart really would be recreated) and false for a pod with no controller;
//!   - the rollout patch is *accepted by the API server* — sent as a server-side
//!     **dry run**, which validates the exact patch shape against a real workload
//!     but persists nothing, so no pods actually roll.

use k7s_lib::kube::restart::{has_controller, is_rollout_kind, restart_patch};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ApiResource, DynamicObject, ListParams, Patch, PatchParams};
use kube::{Client, ResourceExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- has_controller across every pod in the cluster ----
    let pods: Api<Pod> = Api::all(client.clone());
    let all = pods.list(&ListParams::default()).await?;
    let (mut owned, mut bare) = (0usize, 0usize);
    let mut first_bare: Option<String> = None;
    let mut first_owned: Option<String> = None;
    for p in &all.items {
        if has_controller(p) {
            owned += 1;
            first_owned.get_or_insert_with(|| format!("{}/{}", p.namespace().unwrap_or_default(), p.name_any()));
        } else {
            bare += 1;
            first_bare.get_or_insert_with(|| format!("{}/{}", p.namespace().unwrap_or_default(), p.name_any()));
        }
    }
    println!("pods: {} total  —  {owned} controller-owned (restartable), {bare} bare", all.items.len());
    if let Some(o) = &first_owned {
        println!("  restartable e.g. : {o}");
    }
    if let Some(b) = &first_bare {
        println!("  bare (refused)   : {b}  ← restart_pod returns 'use Delete instead'");
    }
    assert!(owned > 0, "a real cluster has controller-owned pods");

    // ---- rollout patch accepted by the API server (dry run, no mutation) ----
    // Pick any Deployment and validate the real patch against it server-side.
    let deploys: Api<Deployment> = Api::all(client.clone());
    let dl = deploys.list(&ListParams::default()).await?;
    let target = dl.items.first().expect("the cluster has at least one Deployment");
    let ns = target.namespace().unwrap_or_default();
    let name = target.name_any();
    println!("\nrollout dry-run target: {ns}/{name}");

    assert!(is_rollout_kind("deployments"));

    // Go through the DynamicObject API, exactly like the command's dynamic_api path.
    let ar = ApiResource::erase::<Deployment>(&());
    let dyn_api: Api<DynamicObject> = Api::namespaced_with(client.clone(), &ns, &ar);

    let now = "2026-07-17T00:00:00+00:00";
    let patch = restart_patch(now);
    println!("patch: {patch}");

    // dry_run: the server validates and returns the would-be object, but writes
    // nothing — so this proves the patch shape without rolling any pods.
    let pp = PatchParams {
        dry_run: true,
        ..Default::default()
    };
    let result = dyn_api.patch(&name, &pp, &Patch::Merge(&patch)).await?;

    let stamped = result
        .data
        .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt")
        .and_then(|v| v.as_str());
    println!("server echoed restartedAt = {stamped:?}  (dry run — not persisted)");
    assert_eq!(stamped, Some(now), "the server must apply the annotation to the template");

    // And confirm we didn't actually change it: re-read and check the live object
    // has no such annotation (unless someone genuinely restarted it before).
    let deploys_ns: Api<Deployment> = Api::namespaced(client.clone(), &ns);
    let live = deploys_ns.get(&name).await?;
    let live_stamp = live
        .spec
        .and_then(|s| s.template.metadata)
        .and_then(|m| m.annotations)
        .and_then(|a| a.get("kubectl.kubernetes.io/restartedAt").cloned());
    println!("live object restartedAt  = {live_stamp:?}  (our dry-run value absent → nothing rolled)");
    assert_ne!(live_stamp.as_deref(), Some(now), "dry run must not have persisted");

    println!("\nRestart logic OK.");
    Ok(())
}
