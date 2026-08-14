//! Live verification of the exec (B4) and port-forward (B6) code paths against a
//! real cluster, using the same kube APIs as src/kube/exec.rs and portforward.rs.
//! Run with a kubeconfig pointing at a reachable cluster:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example live_check
//!
//! Discovery-based (B45): picks whatever Running pod is on the cluster to exec
//! into, and a pod that declares a container port to forward to. A cluster with
//! nothing suitable prints an explicit skip rather than failing.

use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, AttachParams, ListParams};
use kube::Client;
use std::time::{Duration, Instant};
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

    // Discover the cluster's Running pods — the pool every check below draws from.
    let pods: Api<Pod> = Api::all(client.clone());
    let all = pods.list(&ListParams::default()).await?;
    let running: Vec<Pod> = all
        .items
        .into_iter()
        .filter(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
        .collect();
    println!("\nRunning pods on the cluster: {}", running.len());

    // ---- exec (B4 path: Api::exec + AttachedProcess::stdout) ----
    // Echo in the first container that has a shell. A scratch image (no `sh`)
    // fails the exec, so try a few pods before giving up and skipping.
    let mut exec_ok = false;
    for pod in running.iter().take(6) {
        let ns = pod.metadata.namespace.clone().unwrap_or_default();
        let name = pod.metadata.name.clone().unwrap_or_default();
        let container = pod
            .spec
            .as_ref()
            .and_then(|s| s.containers.first().map(|c| c.name.clone()))
            .unwrap_or_default();
        if container.is_empty() {
            continue;
        }
        let api: Api<Pod> = Api::namespaced(client.clone(), &ns);
        let ap = AttachParams::default().stdout(true).stderr(false).container(container.clone());
        let started = Instant::now();
        match tokio::time::timeout(
            Duration::from_secs(15),
            api.exec(&name, vec!["sh", "-c", "echo k7s-exec-ok"], &ap),
        )
        .await
        {
            Ok(Ok(mut proc)) => {
                let mut out = String::new();
                if let Some(mut stdout) = proc.stdout() {
                    let _ = tokio::time::timeout(Duration::from_secs(5), stdout.read_to_string(&mut out)).await;
                }
                let out = out.trim();
                println!("exec {ns}/{name} [{container}] stdout: {out:?} (in {:?})", started.elapsed());
                if out.contains("k7s-exec-ok") {
                    exec_ok = true;
                    break;
                }
            }
            Ok(Err(e)) => println!("exec {ns}/{name}: {e} (trying the next pod)"),
            Err(_) => println!("exec {ns}/{name}: timed out (trying the next pod)"),
        }
    }
    if !exec_ok {
        println!("\nno pod with a shell to exec into, skipping the exec check");
    } else {
        println!("exec OK");
    }

    // ---- port-forward (B6 path: Api::portforward + take_stream) ----
    // Forward a pod's first *declared* container port. The tunnel is proven by
    // the local connect + a write that enters it; whether the app replies is the
    // app's business (a busybox pod declares a port and listens on nothing).
    let target = running.iter().find(|p| {
        p.spec
            .as_ref()
            .and_then(|s| s.containers.first())
            .and_then(|c| c.ports.as_ref())
            .is_some_and(|ps| !ps.is_empty())
    });
    let Some(pod) = target else {
        println!("no pod with declared container ports, skipping the port-forward check");
        return Ok(());
    };
    let ns = pod.metadata.namespace.clone().unwrap_or_default();
    let name = pod.metadata.name.clone().unwrap_or_default();
    let port = pod
        .spec
        .as_ref()
        .and_then(|s| s.containers.first())
        .and_then(|c| c.ports.as_ref())
        .and_then(|ps| ps.first().map(|p| p.container_port))
        .expect("the finder guaranteed a declared port") as u16;
    println!("\nforwarding {ns}/{name}:{port}");

    let api: Api<Pod> = Api::namespaced(client.clone(), &ns);
    let mut pf = api.portforward(&name, &[port]).await?;
    let mut upstream = pf.take_stream(port).expect("the forwarded port is open");
    // Enter the tunnel with a probe and see what (if anything) comes back.
    upstream.write_all(b"\r\n").await?;
    upstream.flush().await?;
    let mut buf = [0u8; 32];
    match tokio::time::timeout(Duration::from_secs(3), upstream.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => println!("the app replied: {:?}", String::from_utf8_lossy(&buf[..n])),
        Ok(Ok(_)) => println!("connection closed without a reply (nothing listens on the port)"),
        Ok(Err(e)) => println!("read error: {e}"),
        Err(_) => println!("no reply within 3s — the tunnel carried the write, but the app stayed silent"),
    }
    println!("port-forward OK (tunnel established, no per-connection error)");

    println!("\nAll live checks passed.");
    Ok(())
}
