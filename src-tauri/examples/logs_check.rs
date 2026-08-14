//! Live verification of the log-reading options (B29) against a real cluster,
//! using the same `log_params` the streams and the export build:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example logs_check
//!
//! Reads the cluster's most-restarted pod every way the UI can, and checks the
//! two claims that matter: that a `previous` read *terminates* (rather than
//! hanging on a dead container), and that a `since` window actually bounds the
//! output.
//!
//! Discovery-based (B45): the pod is found cluster-wide by restart count rather
//! than named. A cluster with no restarted container skips the `previous` read,
//! and one whose logs never pass 200 lines can't demonstrate the export's
//! past-the-ring-buffer point — both print an explicit skip.

use k7s_lib::kube::logs::{log_params, LogStreamOptions};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::Client;
use std::time::Duration;

/// Read a bounded log with the given options, non-following.
async fn read(api: &Api<Pod>, pod: &str, container: &str, opts: LogStreamOptions) -> anyhow::Result<String> {
    let mut lp = log_params(container, &opts);
    lp.follow = false;
    Ok(tokio::time::timeout(Duration::from_secs(20), api.logs(pod, &lp)).await??)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // Find the cluster's most-restarted pod rather than a hardcoded name.
    let pods: Api<Pod> = Api::all(client.clone());
    let list = pods.list(&ListParams::default()).await?;
    let target = list
        .items
        .iter()
        .max_by_key(|p| {
            p.status
                .as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .map(|cs| cs.iter().map(|c| c.restart_count).sum::<i32>())
                .unwrap_or(0)
        });
    let Some(target) = target else {
        println!("no pods on this cluster, skipping");
        return Ok(());
    };

    let ns = target.metadata.namespace.clone().unwrap_or_default();
    let name = target.metadata.name.clone().unwrap_or_default();
    let cs = target.status.as_ref().and_then(|s| s.container_statuses.as_ref());
    let restarts: i32 = cs.map(|c| c.iter().map(|x| x.restart_count).sum()).unwrap_or(0);
    let container = cs.and_then(|c| c.first()).map(|c| c.name.clone()).unwrap_or_default();
    let running = cs
        .and_then(|c| c.first())
        .map(|c| c.state.as_ref().is_some_and(|s| s.running.is_some()))
        .unwrap_or(false);

    println!("pod        : {ns}/{name}");
    println!("container  : {container}");
    println!("restarts   : {restarts}");
    println!("running now: {running}");
    let api: Api<Pod> = Api::namespaced(client.clone(), &ns);

    // ---- current ----
    let current = read(&api, &name, &container, LogStreamOptions { tail: Some(5), ..Default::default() }).await?;
    println!("\n=== current, tail 5 ===\n{}", trim(&current));

    // ---- previous: only when there *is* a previous generation to read. A pod
    //      that never restarted has none, and asking for one is a 400 (B45). ----
    if restarts == 0 {
        println!("\nno restarted container on this cluster, skipping the previous read");
    } else {
        let started = std::time::Instant::now();
        let previous = read(
            &api,
            &name,
            &container,
            LogStreamOptions { tail: Some(5), previous: true, ..Default::default() },
        )
        .await?;
        println!("=== previous, tail 5 (returned in {:?}) ===\n{}", started.elapsed(), trim(&previous));

        // A previous read must terminate — that's what `follow: !previous` buys,
        // and it's the difference between a snapshot and a hung task.
        assert!(started.elapsed() < Duration::from_secs(20), "previous read must not hang");
        assert!(!previous.is_empty(), "a pod with restarts has a previous container");

        // What this fixture can and can't show: while the container sits in
        // CrashLoopBackOff it isn't running, so `current` *already* returns the
        // last terminated container's output — the same bytes as `previous`. The
        // two only diverge once it restarts and is running again. Report which
        // case we saw rather than asserting a difference that depends on timing.
        if current == previous {
            println!(
                "\nNOTE: current == previous. The container is in backoff (not running), so the\n\
                 API serves the last terminated container for both. They diverge once it's\n\
                 running again — which is exactly when `previous` becomes the only way to\n\
                 see why the last attempt died."
            );
        } else {
            println!("\nNOTE: current != previous — the container is running, so `previous` is showing\nthe prior attempt's death that the live stream can no longer reach.");
        }
    }

    // ---- since window ----
    let recent = read(&api, &name, &container, LogStreamOptions { since_seconds: Some(60), ..Default::default() }).await?;
    let all = read(&api, &name, &container, LogStreamOptions::default()).await?;
    println!("=== since=60s: {} lines   vs  no window: {} lines ===", recent.lines().count(), all.lines().count());
    assert!(
        recent.lines().count() <= all.lines().count(),
        "a 60s window cannot return more than the whole log"
    );

    // ---- export (B29): the whole log, not the ring buffer ----
    //
    // This exercises the same read + write `export_logs` performs; the command
    // itself needs a Tauri State that a harness can't construct.
    let export_path = std::env::temp_dir().join("k7s-logs-check.log");
    let mut lp = log_params(&container, &LogStreamOptions::default());
    lp.follow = false;
    let whole = api.logs(&name, &lp).await?;
    std::fs::write(&export_path, &whole)?;
    let written = std::fs::read_to_string(&export_path)?;
    let line_count = written.lines().count();

    println!(
        "\n=== export {ns}/{name}: {line_count} lines, {} bytes → {}",
        written.len(),
        export_path.display()
    );
    assert_eq!(written, whole, "the file must be exactly what the API returned");

    // The point of export is recovering the part that scrolled out of the
    // 200-line view. A quiet pod can't demonstrate that — skip the claim rather
    // than fail on a fixture that isn't chatty (B45).
    if line_count > 200 {
        println!("    the view's ring buffer holds 200 — the file has {line_count}");
    } else {
        println!(
            "    {line_count} lines ≤ the 200-line ring buffer — this pod isn't chatty enough to\n    prove the past-the-ring-buffer point, skipping that check"
        );
    }

    // And a window still bounds the export, so "last 5m" saves 5 minutes.
    let mut windowed = log_params(&container, &LogStreamOptions { since_seconds: Some(300), ..Default::default() });
    windowed.follow = false;
    let recent_text = api.logs(&name, &windowed).await?;
    println!("    with since=5m: {} lines", recent_text.lines().count());
    assert!(recent_text.lines().count() <= line_count);

    std::fs::remove_file(&export_path).ok();

    println!("\nLog options OK.");
    Ok(())
}

/// Last few lines, indented.
fn trim(s: &str) -> String {
    s.lines().map(|l| format!("    {}", &l[..l.len().min(110)])).collect::<Vec<_>>().join("\n")
}
