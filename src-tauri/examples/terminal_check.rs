//! Live verification of the local kubectl terminal's core (B82) against a real
//! cluster — the pty spawn, the temp KUBECONFIG, and `kubectl` reading it:
//!
//!   ./dev/cluster/up.sh                          # fixture up (context kind-k7s-dev)
//!   KUBECONFIG=... cargo run --example terminal_check
//!
//! Spawns the user's shell on a real pty with KUBECONFIG set to a temp
//! single-context file — exactly what `start_kubectl_terminal` does — types
//! `kubectl config current-context` and `kubectl get pods -A`, and asserts
//! kubectl targets the *viewed* cluster, not the machine's default.
//!
//! The default-vs-viewed split is the acceptance criterion: the terminal binds
//! to cluster A by writing its own single-context KUBECONFIG, so even when the
//! machine's default context is a different cluster B, kubectl inside the
//! terminal lists A. The harness proves both halves:
//!   - the terminal (KUBECONFIG = temp-A) lists A's fixture pods; and
//!   - a control shell whose ambient default is a *different, unreachable*
//!     cluster B does NOT list A — so the terminal's success came from its own
//!     KUBECONFIG, not the ambient default.
//!
//! The fixture context is the default target; `K7S_TERMINAL_CONTEXT` overrides
//! it (the "A" to bind to). Writes temp kubeconfigs and deletes them (the
//! session discipline).

use k8s_openapi::api::core::v1::Pod;
use k7s_lib::kube::{client, terminal};
use kube::api::{Api, ListParams};
use kube::Client;
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

/// Run `commands` in a fresh shell on a pty whose KUBECONFIG is `kubeconfig`,
/// type `exit` after them, and return everything the pty printed. Uses the
/// production spawn path — `terminal::spawn_shell_pty` over
/// `default_shell_command` — so this exercises exactly what a real terminal does.
///
/// The pty is drained on a reader thread feeding a channel, and the pump waits
/// with `recv_timeout`, so a command that stalls mid-flight (kubectl wedged
/// before printing anything) can't block the harness past its deadline.
fn run_in_terminal(kubeconfig: &Path, commands: &[&str]) -> String {
    let shell = terminal::default_shell_command("");
    let (master, mut child) = terminal::spawn_shell_pty(
        &shell,
        kubeconfig,
        &terminal::login_shell_path(),
        80,
        24,
    )
    .expect("spawn shell on a pty");
    let reader = master.try_clone_reader().expect("clone pty reader");
    let mut writer = master.take_writer().expect("take pty writer");

    let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || out_tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    // Give the shell a beat to print its prompt, then run each command.
    std::thread::sleep(Duration::from_millis(800));
    for cmd in commands {
        writer.write_all(cmd.as_bytes()).expect("write command");
        writer.write_all(b"\r").expect("write carriage return");
    }
    writer.write_all(b"exit\r").expect("write exit");

    let mut out = String::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if Instant::now() > deadline {
            break;
        }
        match out_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    out
}

/// A just-freed localhost port — closed now, with nothing else able to bind it
/// in the instant before the harness connects. More portable than a fixed port
/// like 9, which some systems' `discard` service or HTTP responder answers.
fn closed_localhost_port() -> u16 {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().expect("ephemeral port addr").port();
    drop(listener);
    port
}

/// A minimal kubeconfig for a *different*, unreachable cluster — the "machine
/// default B" a user might have while the app's terminal is bound to A. The
/// user carries a bogus token so client-go attempts the request and fails fast
/// with connection refused, rather than dropping into an interactive
/// `Please enter Username:` prompt. Not a terminal file (its prefix isn't
/// swept), so it stays put until removed below.
fn write_fake_kubeconfig(prefix: &str, context: &str, server: &str) -> std::path::PathBuf {
    let body = format!(
        concat!(
            "apiVersion: v1\n",
            "kind: Config\n",
            "current-context: {context}\n",
            "clusters:\n",
            "- name: {context}\n",
            "  cluster:\n",
            "    server: {server}\n",
            "contexts:\n",
            "- name: {context}\n",
            "  context:\n",
            "    cluster: {context}\n",
            "    user: {context}\n",
            "users:\n",
            "- name: {context}\n",
            "  user:\n",
            "    token: bogus\n",
        ),
        context = context,
        server = server,
    );
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}{nanos}.yaml"));
    std::fs::write(&path, body).expect("write fake kubeconfig");
    path
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ---- the pure pieces ----
    let login_path = terminal::login_shell_path();
    assert!(!login_path.is_empty(), "the login shell yields a PATH");
    let kubectl = terminal::find_kubectl(&login_path)
        .unwrap_or_else(|| panic!("kubectl must be on the login PATH for this check (it is on this machine)"));
    println!("login PATH resolves kubectl: {kubectl}");

    // ---- bind the terminal to cluster A: the fixture context, by name ----
    // `K7S_TERMINAL_CONTEXT` names the viewed cluster A; default is the current
    // context (kind-k7s-dev after ./dev/cluster/up.sh).
    let contexts = client::list_contexts().ok().unwrap_or_default();
    let a = std::env::var("K7S_TERMINAL_CONTEXT")
        .ok()
        .or_else(|| contexts.iter().find(|c| c.current).map(|c| c.name.clone()))
        .ok_or_else(|| anyhow::anyhow!("no kubeconfig context — run ./dev/cluster/up.sh"))?;
    println!("terminal bound to cluster A: {a}");

    let kubeconfig_file = client::default_kubeconfig_path();
    let full = std::fs::read_to_string(&kubeconfig_file)
        .map_err(|e| anyhow::anyhow!("could not read kubeconfig: {e}"))?;
    let yaml = client::extract_context_yaml(&full, &a)
        .map_err(|e| anyhow::anyhow!("could not build single-context kubeconfig: {e}"))?;
    terminal::sweep_orphan_kubeconfigs();
    let term_kubeconfig = terminal::write_temp_kubeconfig(&yaml)?;
    println!("terminal KUBECONFIG: {}", term_kubeconfig.display());

    // ---- the app's own table is the ground truth for what A has ----
    let client = Client::try_default().await?;
    let pods: Api<Pod> = Api::all(client);
    let listed = pods.list(&ListParams::default()).await?.items;
    let table_pod = listed
        .iter()
        .find(|p| p.metadata.name.as_deref().is_some_and(|n| n.starts_with("bifrost-gateway")))
        .and_then(|p| p.metadata.name.clone())
        .ok_or_else(|| anyhow::anyhow!("the fixture has no bifrost-gateway pod"))?;

    // ---- the terminal's own kubectl: bound to A, not the machine default ----
    let out = run_in_terminal(
        &term_kubeconfig,
        &["kubectl config current-context", "kubectl get pods -A"],
    );
    println!("\nterminal output contained:");
    println!("  current-context {a}: {}", out.contains(&a));
    println!("  the app's pod ({table_pod}): {}", out.contains(&table_pod));
    assert!(
        out.contains(&table_pod),
        "kubectl in the terminal must list the same pods as the app (got the table's {table_pod})"
    );

    // ---- the "default is B" control: an ambient default that is a different, ----
    // ---- unreachable cluster must NOT see A — so the terminal's win above   ----
    // ---- came from its own KUBECONFIG, not the ambient default.             ----
    let server_b = format!("https://127.0.0.1:{}", closed_localhost_port());
    let default_b = write_fake_kubeconfig("k7s-default-b-", "cluster-b", &server_b);
    let b_out = run_in_terminal(
        &default_b,
        &[
            "kubectl config current-context",
            "kubectl --request-timeout=5s get pods -A",
        ],
    );
    println!("\ncontrol (ambient default B, unreachable) contained:");
    println!("  current-context cluster-b: {}", b_out.contains("cluster-b"));
    println!("  the app's pod ({table_pod}): {}", b_out.contains(&table_pod));
    assert!(b_out.contains("cluster-b"), "the control's default context is B");
    assert!(
        !b_out.contains(&table_pod),
        "B is a different, unreachable cluster — it must not list A's pods, so the terminal's \
         success came from its own KUBECONFIG, not the ambient default"
    );

    // ---- cleanup: the temp kubeconfig never outlives the session ----
    terminal::sweep_orphan_kubeconfigs();
    assert!(
        !term_kubeconfig.exists(),
        "the terminal's temp kubeconfig is gone after the session"
    );
    let _ = std::fs::remove_file(&default_b);
    println!(
        "\nTerminal path OK (pty + temp KUBECONFIG binds the viewed cluster even when the default is another)."
    );
    Ok(())
}
