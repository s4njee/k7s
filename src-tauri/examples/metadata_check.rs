//! Live verification of the metadata editor path (B88): an RFC 6902 JSON Patch
//! to a pod's labels round-trips through the API and the watcher reflects it
//! without a manual refresh — the acceptance's first line.
//!
//!   ./dev/cluster/up.sh
//!   KUBECONFIG=... cargo run --example metadata_check
//!
//! Patches a label onto a running fixture pod, proves the watcher carries the
//! change, then removes it (cleanup). The patch-machinery helpers themselves
//! (RFC 6902 op building, the Helm guard) are unit-tested in commands.rs; this
//! harness proves the live round-trip against a real API server.

use futures::StreamExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::runtime::watcher;
use kube::{Client, ResourceExt};
use std::time::Duration;

const LABEL: &str = "k7s.metadata-check";
const VALUE: &str = "b88";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;
    let pods: Api<Pod> = Api::all(client.clone());
    let list = pods.list(&ListParams::default()).await?;
    let pod = list
        .items
        .into_iter()
        .find(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
        .ok_or_else(|| anyhow::anyhow!("no Running pod to patch"))?;
    let ns = pod.metadata.namespace.clone().unwrap_or_default();
    let name = pod.name_any();
    let api: Api<Pod> = Api::namespaced(client.clone(), &ns);

    // Watch first: the acceptance is that the change reaches the watcher without
    // a manual refresh, so the watcher must be listening before the patch lands.
    let stream = watcher::<Pod>(api.clone(), watcher::Config::default());
    tokio::pin!(stream);

    let pointer = |p: &str| json_patch::jsonptr::PointerBuf::parse(p).expect("valid pointer");
    let add = json_patch::Patch(vec![json_patch::PatchOperation::Add(json_patch::AddOperation {
        path: pointer(&format!("/metadata/labels/{LABEL}")),
        value: serde_json::json!(VALUE),
    })]);
    api.patch(&name, &PatchParams::default(), &Patch::Json::<()>(add)).await?;

    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let ev = stream.next().await.expect("watcher stream ended");
            if let Ok(watcher::Event::Apply(obj)) | Ok(watcher::Event::InitApply(obj)) = ev {
                if obj
                    .metadata
                    .labels
                    .as_ref()
                    .map(|l| l.get(LABEL) == Some(&VALUE.to_string()))
                    .unwrap_or(false)
                {
                    break;
                }
            }
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("the watcher never saw the patched label"))?;
    println!("watcher saw the patched label on {ns}/{name}");

    // Round-trip via get, then clean up.
    let got = api.get(&name).await?;
    assert_eq!(
        got.metadata.labels.as_ref().and_then(|l| l.get(LABEL)).map(String::as_str),
        Some(VALUE),
        "the patched label must round-trip through the API"
    );

    let remove = json_patch::Patch(vec![json_patch::PatchOperation::Remove(json_patch::RemoveOperation {
        path: pointer(&format!("/metadata/labels/{LABEL}")),
    })]);
    api.patch(&name, &PatchParams::default(), &Patch::Json::<()>(remove)).await?;
    let after = api.get(&name).await?;
    assert!(
        after.metadata.labels.as_ref().map(|l| !l.contains_key(LABEL)).unwrap_or(true),
        "cleanup must remove the label"
    );

    println!("\nMetadata round-trip OK — the JSON Patch propagated through the watcher and cleaned up.");
    Ok(())
}
