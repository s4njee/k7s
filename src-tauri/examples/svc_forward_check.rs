//! Live verification of Service port-forwarding (B16) against a real cluster,
//! using the same `resolve_service` + `run_port_forward` the commands call:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example svc_forward_check
//!
//! Covers the three resolution cases freya happens to provide:
//!   - a *named* targetPort   (csearch-redis 6379 → "redis")
//!   - a remapped numeric one (argocd-server 80 → 8080)
//!   - a selector-less Service (kubernetes 443), which must be a clean error
//!
//! then forwards the named-targetPort Service and sends a Redis PING through the
//! tunnel — proving a Service forward carries real traffic without the caller
//! naming a pod.

use k7s_lib::kube::portforward;
use kube::Client;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- resolution ----
    println!("--- resolve_service ---");

    // Named targetPort: the pod's container port is found by name, not number.
    let (pod, port) =
        portforward::resolve_service(client.clone(), "default", "csearch-redis", 6379).await?;
    println!("csearch-redis:6379 (named \"redis\") → pod {pod} port {port}");

    // Numeric remap: service port differs from the container port.
    let (srv_pod, srv_port) =
        portforward::resolve_service(client.clone(), "argocd", "argocd-server", 80).await?;
    println!("argocd-server:80 → pod {srv_pod} port {srv_port}");
    assert_eq!(srv_port, 8080, "targetPort 8080 should win over the service port");

    // Selector-less Service: must fail with a readable message, not a panic.
    match portforward::resolve_service(client.clone(), "default", "kubernetes", 443).await {
        Ok(_) => panic!("selector-less service should not resolve"),
        Err(e) => println!("kubernetes:443 → correctly refused: {e}"),
    }

    // A port the Service doesn't publish should say so, and list what it has.
    match portforward::resolve_service(client.clone(), "argocd", "argocd-server", 9999).await {
        Ok(_) => panic!("unknown port should not resolve"),
        Err(e) => println!("argocd-server:9999 → correctly refused: {e}"),
    }

    // ---- a real tunnel through the resolved pod ----
    println!("\n--- forwarding csearch-redis via {pod}:{port} ---");
    let (ready_tx, ready_rx) = oneshot::channel();
    let (err_tx, mut err_rx) = mpsc::channel::<String>(8);
    let task = tokio::spawn(portforward::run_port_forward(
        client,
        "default".to_string(),
        pod.clone(),
        port,
        ready_tx,
        err_tx,
    ));

    let local = ready_rx.await?.map_err(anyhow::Error::msg)?;
    println!("listening on localhost:{local}");

    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", local)).await?;
    sock.write_all(b"PING\r\n").await?;
    let mut buf = [0u8; 64];
    let n = sock.read(&mut buf).await?;
    let resp = String::from_utf8_lossy(&buf[..n]).to_string();
    println!("redis replied: {resp:?}");
    assert!(resp.contains("PONG"), "expected a PONG through the service forward");

    // No per-connection errors should have been reported for a healthy forward.
    assert!(err_rx.try_recv().is_err(), "unexpected forward error");

    task.abort();
    println!("\nService port-forward OK.");
    Ok(())
}
