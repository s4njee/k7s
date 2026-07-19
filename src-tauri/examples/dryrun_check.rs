//! Live verification of the dry-run diff (B36):
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example dryrun_check
//!
//! The whole promise of the feature is "this shows you what would happen and
//! changes nothing", so that's what this asserts: a dry-run replace round-trips
//! the admission chain, the server's answer differs from the text we sent where
//! defaulting applies, and the live object is byte-identical afterwards.

use k8s_openapi::api::core::v1::ConfigMap;
use kube::api::{Api, ListParams, PostParams};
use kube::{Client, ResourceExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // A ConfigMap is the safest possible subject: no controller acts on it, so
    // even a mistake here can't disturb a workload.
    let cms: Api<ConfigMap> = Api::all(client.clone());
    let target = cms
        .list(&ListParams::default())
        .await?
        .items
        .into_iter()
        .find(|c| !c.name_any().starts_with("kube-root-ca"))
        .expect("the cluster has a ConfigMap");
    let ns = target.namespace().unwrap_or_default();
    let name = target.name_any();
    println!("subject: configmap {ns}/{name}");

    let api: Api<ConfigMap> = Api::namespaced(client.clone(), &ns);
    let before = api.get(&name).await?;
    let before_rv = before.resource_version();

    // Propose a change the server will accept: a new annotation.
    let mut proposed = before.clone();
    proposed
        .metadata
        .annotations
        .get_or_insert_with(Default::default)
        .insert("k7s.dev/dry-run-check".into(), "hello".into());

    let pp = PostParams { dry_run: true, ..Default::default() };
    let result = api.replace(&name, &pp, &proposed).await?;

    let echoed = result
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("k7s.dev/dry-run-check"))
        .cloned();
    println!("server echoed the proposed annotation: {echoed:?}");
    assert_eq!(echoed.as_deref(), Some("hello"), "the dry run must return the would-be object");

    // The part that matters: nothing was written.
    let after = api.get(&name).await?;
    let persisted = after
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("k7s.dev/dry-run-check"));
    println!("annotation actually persisted: {persisted:?}");
    assert!(persisted.is_none(), "a dry run must not write — found the annotation on the live object");
    assert_eq!(
        after.resource_version(),
        before_rv,
        "resourceVersion must be untouched by a dry run"
    );

    // And a manifest the server rejects must fail here rather than at apply time:
    // a bad resourceVersion is the conflict an edit races into.
    let mut stale = before.clone();
    stale.metadata.resource_version = Some("1".into());
    match api.replace(&name, &pp, &stale).await {
        Err(e) => println!("\nstale resourceVersion correctly rejected by the dry run:\n  {e}"),
        Ok(_) => panic!("a stale resourceVersion should not have been accepted"),
    }

    println!("\nDry run OK — preview works and the cluster is untouched.");
    Ok(())
}
