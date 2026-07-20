//! Live verification of the node debug shell (B53):
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example nodeshell_check
//!
//! By default this is **read-only**. It sends the debug pod spec with
//! `dryRun=All`, so the API server runs the full admission chain — validation,
//! defaulting, and crucially Pod Security Admission — and tells us whether the
//! pod *would* be created, without creating it. That's the failure worth catching
//! cheaply: on a cluster that enforces the `baseline` or `restricted` PSA profile,
//! a privileged pod is rejected outright and the whole feature is a non-starter.
//!
//! The full cycle — actually create the pod, `nsenter` into the host, prove we
//! escaped the container, then delete it — is gated behind an explicit flag,
//! because it really does put a privileged pod on a real node:
//!
//!   cargo run --example nodeshell_check -- --for-real
//!
//! Even then it targets a Ready node, cleans up on every exit path, and the pod
//! carries `activeDeadlineSeconds` as a backstop.

use k8s_openapi::api::core::v1::{Node, Pod};
use k7s_lib::kube::nodeshell;
use kube::api::{Api, AttachParams, DeleteParams, ListParams, PostParams};
use kube::{Client, ResourceExt};
use tokio::io::AsyncReadExt;

/// First node reporting Ready. A NotReady node never starts the pod, so pointing
/// the check at one would prove nothing about the feature.
async fn ready_node(client: &Client) -> anyhow::Result<String> {
    let nodes: Api<Node> = Api::all(client.clone());
    for node in nodes.list(&ListParams::default()).await?.items {
        let ready = node
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_ref())
            .map(|cs| {
                cs.iter().any(|c| c.type_ == "Ready" && c.status == "True")
            })
            .unwrap_or(false);
        if ready {
            return Ok(node.name_any());
        }
    }
    anyhow::bail!("no Ready node to test against")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let for_real = std::env::args().any(|a| a == "--for-real");
    let client = Client::try_default().await?;
    let node = ready_node(&client).await?;
    println!("target node: {node}");

    let api: Api<Pod> = Api::namespaced(client.clone(), nodeshell::DEBUG_NAMESPACE);
    let name = nodeshell::pod_name(&node, 0);
    let spec = nodeshell::debug_pod_spec(&node, nodeshell::DEFAULT_IMAGE, &name);

    // ---- always: does admission accept a privileged pod here? ----
    let dry = PostParams { dry_run: true, ..Default::default() };
    match api.create(&dry, &spec).await {
        Ok(accepted) => {
            println!("admission accepts the debug pod (dry run)");
            let s = accepted.spec.expect("a created pod has a spec");
            // Re-assert the safety net *as the server stored it*, not as we sent
            // it: a mutating webhook is entirely capable of stripping the field,
            // and that would silently remove the only guarantee that survives a
            // crash of this app.
            assert_eq!(
                s.active_deadline_seconds,
                Some(nodeshell::MAX_LIFETIME_SECS),
                "the server did not preserve activeDeadlineSeconds — the crash backstop is gone"
            );
            println!("  activeDeadlineSeconds survived admission: {:?}", s.active_deadline_seconds);
            assert_eq!(s.host_pid, Some(true), "hostPID was stripped — nsenter would target the wrong init");
        }
        Err(e) => {
            println!("\nadmission REJECTED the debug pod:\n  {e}");
            println!("\nOn a cluster enforcing Pod Security 'baseline' or 'restricted', this is");
            println!("expected — the node shell cannot work there without a PSA exemption.");
            return Ok(());
        }
    }

    if !for_real {
        println!("\nDry run OK — nothing was created. Re-run with --for-real for the full cycle.");
        return Ok(());
    }

    // ---- opt-in: the real thing ----
    println!("\n--for-real: creating an actual privileged pod on {node}");
    api.create(&PostParams::default(), &spec).await?;

    // Everything past this point must clean up, so the result is captured rather
    // than `?`-propagated — an early return here would strand a privileged pod.
    let outcome = run_live_checks(&api, &name, &node).await;

    println!("\ncleaning up {name}");
    let dp = DeleteParams { grace_period_seconds: Some(0), ..Default::default() };
    api.delete(&name, &dp).await?;

    // Prove the cleanup, rather than assuming the delete call meant it happened.
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if api.get(&name).await.is_err() {
            println!("pod is gone");
            outcome?;
            println!("\nNode shell OK — host access proven and the pod cleaned up.");
            return Ok(());
        }
    }
    outcome?;
    anyhow::bail!("pod {name} still exists after delete — clean it up by hand")
}

/// Wait for Running, then prove the shell really escapes into the host.
async fn run_live_checks(api: &Api<Pod>, name: &str, node: &str) -> anyhow::Result<()> {
    for i in 0..120 {
        let pod = api.get(name).await?;
        let phase = pod.status.and_then(|s| s.phase).unwrap_or_default();
        if phase == "Running" {
            println!("pod Running after ~{}s", i / 2);
            break;
        }
        if i == 119 {
            anyhow::bail!("pod never reached Running (last phase: {phase})");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // The claim under test: `nsenter --mount ... --target 1` puts us in the host's
    // namespaces. If it does, `hostname` is the *node's*, not the pod's — the pod's
    // would be the pod name. This is the difference between "a container on the
    // node" and "a shell on the node", which is the entire feature.
    let out = exec_capture(api, name, vec!["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "hostname"]).await?;
    let host = out.trim();
    println!("hostname inside the shell: {host:?}");
    assert!(
        !host.is_empty() && host != name,
        "expected the node's hostname, got the pod's ({host:?}) — nsenter did not escape the container"
    );
    // Node objects are usually named after the host, but not always (cloud
    // providers use instance ids), so this is a note rather than an assertion.
    if host != node {
        println!("  (note: node object is {node:?}, host reports {host:?} — normal on some providers)");
    }

    // Host PID namespace: PID 1 on the host is the init system, never our `sleep`.
    let comm = exec_capture(api, name, vec!["cat", "/proc/1/comm"]).await?;
    println!("host PID 1 is: {:?}", comm.trim());
    assert!(
        comm.trim() != "sleep",
        "PID 1 is our own container's sleep — hostPID is not in effect"
    );

    Ok(())
}

/// Run a command in the debug container and collect its stdout.
async fn exec_capture(api: &Api<Pod>, name: &str, cmd: Vec<&str>) -> anyhow::Result<String> {
    let ap = AttachParams::default().stdout(true).stderr(false).container("debug");
    let mut proc = api.exec(name, cmd, &ap).await?;
    let mut stdout = proc.stdout().ok_or_else(|| anyhow::anyhow!("no stdout"))?;
    let mut buf = String::new();
    stdout.read_to_string(&mut buf).await?;
    Ok(buf)
}
