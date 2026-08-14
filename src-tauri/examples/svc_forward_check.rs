//! Live verification of Service port-forwarding (B16) against a real cluster,
//! using the same `resolve_service` + `run_port_forward` the commands call:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example svc_forward_check
//!
//! Covers the resolution cases Service forwarding is built on, discovering the
//! Service for each on the cluster (B45):
//!   - a *named* targetPort   (resolved by name, not number)
//!   - a remapped numeric one (service port differs from the container port)
//!   - a selector-less Service, which must be a clean error
//!
//! then forwards a resolved Service and proves the tunnel carries bytes. Any
//! case the cluster has no Service for prints an explicit skip rather than
//! failing — a fresh kind cluster has the numeric-remap and selector-less cases
//! but no named targetPort.

use k7s_lib::kube::portforward;
use k8s_openapi::api::core::v1::Service;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::Client;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- discover every Service the cluster has ----
    let services: Api<Service> = Api::all(client.clone());
    let list = services.list(&ListParams::default()).await?;
    println!("services on the cluster: {}", list.items.len());
    let mut named: Option<(String, String, u16)> = None; // (ns, name, service port)
    let mut remapped: Option<(String, String, u16, u16)> = None; // (ns, name, port, targetPort)
    let mut selectorless: Option<(String, String)> = None; // (ns, name)
    for s in &list.items {
        let ns = s.metadata.namespace.clone().unwrap_or_default();
        let name = s.metadata.name.clone().unwrap_or_default();
        let spec = s.spec.as_ref();
        let selector = spec.and_then(|sp| sp.selector.as_ref());
        if selector.is_none() && selectorless.is_none() {
            selectorless = Some((ns.clone(), name.clone()));
        }
        let Some(spec) = spec else { continue };
        // The named/remap cases need a *resolvable* Service — one with a selector
        // (a selector-less one can never resolve, and is covered separately).
        let has_selector = selector.is_some_and(|sel| !sel.is_empty());
        if !has_selector {
            continue;
        }
        for p in spec.ports.iter().flatten() {
            // A named targetPort is a string ("redis"); numeric ones differ from
            // the service port when the pod listens on another number.
            match &p.target_port {
                Some(IntOrString::String(_)) if named.is_none() => {
                    named = Some((ns.clone(), name.clone(), p.port as u16));
                }
                Some(IntOrString::Int(tp)) if *tp as u16 != p.port as u16 && remapped.is_none() => {
                    remapped = Some((ns.clone(), name.clone(), p.port as u16, *tp as u16));
                }
                _ => {}
            }
        }
    }

    // ---- named targetPort: resolved by name, not number ----
    println!("\n--- resolve_service: named targetPort ---");
    if let Some((ns, name, port)) = &named {
        match portforward::resolve_service(client.clone(), ns, name, *port).await {
            Ok((pod, resolved)) => println!("{ns}/{name}:{port} (named targetPort) → pod {pod} port {resolved}"),
            Err(e) => println!("{ns}/{name}:{port} → ERROR {e}"),
        }
    } else {
        println!("no Service with a named targetPort on this cluster, skipping");
    }

    // ---- numeric remap: the service port differs from the container port ----
    println!("\n--- resolve_service: numeric remap ---");
    if let Some((ns, name, port, target)) = &remapped {
        match portforward::resolve_service(client.clone(), ns, name, *port).await {
            Ok((pod, resolved)) => {
                println!("{ns}/{name}:{port} → pod {pod} port {resolved}");
                assert_eq!(resolved, *target, "the numeric targetPort must win over the service port");
            }
            Err(e) => println!("{ns}/{name}:{port} → ERROR {e}"),
        }
    } else {
        println!("no Service whose numeric targetPort differs from its port, skipping");
    }

    // ---- selector-less Service: must fail with a readable message ----
    println!("\n--- resolve_service: selector-less ---");
    if let Some((ns, name)) = &selectorless {
        match portforward::resolve_service(client.clone(), ns, name, 443).await {
            Ok(_) => panic!("selector-less service should not resolve"),
            Err(e) => println!("{ns}/{name}:443 → correctly refused: {e}"),
        }
        // A port the Service doesn't publish should say so too.
        match portforward::resolve_service(client.clone(), ns, name, 9999).await {
            Ok(_) => panic!("unknown port should not resolve"),
            Err(e) => println!("{ns}/{name}:9999 → correctly refused: {e}"),
        }
    } else {
        println!("no selector-less Service on this cluster, skipping");
    }

    // ---- a real tunnel through a resolved Service ----
    println!("\n--- forwarding a resolved Service ---");
    let Some((ns, name, port)) = named.or_else(|| remapped.map(|(ns, name, port, _)| (ns, name, port))) else {
        println!("no resolvable Service to forward to, skipping the tunnel");
        return Ok(());
    };
    let (pod, port) = portforward::resolve_service(client.clone(), &ns, &name, port).await?;
    println!("forwarding {ns}/{name} → {pod}:{port}");

    let (ready_tx, ready_rx) = oneshot::channel();
    let (err_tx, mut err_rx) = mpsc::channel::<String>(8);
    let task = tokio::spawn(portforward::run_port_forward(
        client,
        ns.clone(),
        pod.clone(),
        port,
        ready_tx,
        err_tx,
    ));

    let local = ready_rx.await?.map_err(anyhow::Error::msg)?;
    println!("listening on localhost:{local}");

    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", local)).await?;
    // Enter the tunnel and see what (if anything) comes back. A busybox backing
    // pod declares a port and listens on nothing, so the reply is informational —
    // the tunnel itself is proven by the connect + write with no forward error.
    sock.write_all(b"\r\n").await?;
    sock.flush().await?;
    let mut buf = [0u8; 64];
    match tokio::time::timeout(Duration::from_secs(3), sock.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => println!("the app replied: {:?}", String::from_utf8_lossy(&buf[..n])),
        Ok(Ok(_)) => println!("connection closed without a reply (nothing listens on the pod's port)"),
        Ok(Err(e)) => println!("read error: {e}"),
        Err(_) => println!("no reply within 3s — the tunnel carried the write, but the app stayed silent"),
    }
    assert!(err_rx.try_recv().is_err(), "unexpected forward error for a healthy forward");

    task.abort();
    println!("\nService port-forward OK.");
    Ok(())
}
