//! Live verification of the exec (B4) and port-forward (B6) code paths against a
//! real cluster, using the same kube APIs as src/kube/exec.rs and portforward.rs.
//! Run with a kubeconfig pointing at a reachable cluster:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example live_check
//!
//! Picks the argocd-redis pod, runs `echo` in it (exec), then opens a portforward
//! to 6379 and sends a Redis PING (port-forward).

use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, AttachParams, ListParams};
use kube::Client;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- events (B1 path): find a pod with events, query the same way get_events does ----
    {
        let all_events: Api<Event> = Api::all(client.clone());
        let all = all_events
            .list(&ListParams::default().fields("involvedObject.kind=Pod"))
            .await?;
        println!("cluster pod-events found: {}", all.items.len());
        if let Some(ev) = all.items.iter().find(|e| e.involved_object.name.is_some()) {
            let ns = ev.involved_object.namespace.clone().unwrap_or_default();
            let name = ev.involved_object.name.clone().unwrap_or_default();
            let ns_api: Api<Event> = Api::namespaced(client.clone(), &ns);
            let lp = ListParams::default()
                .fields(&format!("involvedObject.name={name},involvedObject.namespace={ns}"));
            match ns_api.list(&lp).await {
                Ok(list) => println!("get_events({ns}/{name}) → {} events", list.items.len()),
                Err(e) => println!("get_events ERROR: {e}"),
            }
        }
    }

    let pods: Api<Pod> = Api::namespaced(client, "argocd");

    // Find the argocd-redis pod.
    let list = pods
        .list(&ListParams::default().labels("app.kubernetes.io/name=argocd-redis"))
        .await?;
    let pod = list
        .items
        .into_iter()
        .find_map(|p| p.metadata.name)
        .ok_or_else(|| anyhow::anyhow!("no argocd-redis pod found"))?;
    println!("target pod: {pod}");

    // ---- exec (B4 path: Api::exec + AttachedProcess::stdout) ----
    let ap = AttachParams::default()
        .stdout(true)
        .stderr(false)
        .container("redis".to_string());
    let mut proc = pods
        .exec(&pod, vec!["sh", "-c", "echo k7s-exec-ok"], &ap)
        .await?;
    let mut stdout = proc.stdout().unwrap();
    let mut out = String::new();
    stdout.read_to_string(&mut out).await?;
    let out = out.trim();
    println!("exec stdout: {out:?}");
    anyhow::ensure!(out.contains("k7s-exec-ok"), "exec output mismatch");
    println!("exec OK");

    // ---- port-forward (B6 path: Api::portforward + take_stream) ----
    let mut pf = pods.portforward(&pod, &[6379]).await?;
    let mut upstream = pf.take_stream(6379).unwrap();
    upstream.write_all(b"PING\r\n").await?;
    upstream.flush().await?;
    let mut buf = [0u8; 32];
    let n = upstream.read(&mut buf).await?;
    let resp = String::from_utf8_lossy(&buf[..n]);
    println!("redis replied: {resp:?}");
    // Any RESP reply (+PONG, or -NOAUTH when the server requires auth) proves the
    // tunnel carried bytes both ways.
    anyhow::ensure!(
        resp.starts_with('+') || resp.starts_with('-'),
        "no Redis reply through the tunnel"
    );
    println!("port-forward OK");

    println!("\nAll live checks passed.");
    Ok(())
}
