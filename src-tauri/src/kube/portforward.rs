//! Port-forwarding a pod port to a local TCP listener (B6).
//!
//! A forward binds `127.0.0.1:0` (an OS-assigned local port) and, for each
//! incoming local connection, opens a fresh `portforward` to the pod and pumps
//! bytes bidirectionally. Per-connection tasks live in a JoinSet owned by the
//! accept loop, so aborting the forward (on stop / disconnect) tears down every
//! connection with it.

use crate::error::AppError;
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinSet;

/// Run a port-forward accept loop. Sends the bound local port (or an error) back
/// through `ready` once the listener is up, then serves connections until aborted.
pub async fn run_port_forward(
    client: Client,
    namespace: String,
    pod: String,
    remote_port: u16,
    ready: oneshot::Sender<Result<u16, String>>,
) {
    let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(l) => l,
        Err(e) => {
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };
    let local_port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };
    // Report success (with the chosen local port) before entering the accept loop.
    if ready.send(Ok(local_port)).is_err() {
        return; // caller went away
    }

    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut conns = JoinSet::new();

    while let Ok((mut tcp, _)) = listener.accept().await {
        let api = api.clone();
        let pod = pod.clone();
        conns.spawn(async move {
            // One portforward stream per local connection.
            if let Ok(mut pf) = api.portforward(&pod, &[remote_port]).await {
                if let Some(mut upstream) = pf.take_stream(remote_port) {
                    // Pump until either side closes.
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut upstream).await;
                }
            }
        });
    }
}

/// Ensure a pod exists (friendly error otherwise) before forwarding to it.
pub async fn ensure_pod(client: Client, namespace: &str, pod: &str) -> Result<(), AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    match api.get_opt(pod).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(AppError::NotFound(format!("pod {pod} not found"))),
        Err(e) => Err(AppError::Kube(e.to_string())),
    }
}
