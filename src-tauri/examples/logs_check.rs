//! Live verification of the log-reading options (B29) against a real cluster,
//! using the same `log_params` the streams and the export build:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example logs_check
//!
//! Reads freya's crash-looping wiki pod every way the UI can, and checks the two
//! claims that matter: that a `previous` read *terminates* (rather than hanging
//! on a dead container), and that a `since` window actually bounds the output.

use k7s_lib::kube::logs::{log_params, LogStreamOptions};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::{Client, ResourceExt};
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
    let api: Api<Pod> = Api::namespaced(client.clone(), "wiki");

    // Find the crash-looper by its restart count rather than a hardcoded name —
    // the pod is recreated when the Deployment rolls.
    let pods = api.list(&ListParams::default()).await?;
    let target = pods
        .items
        .iter()
        .max_by_key(|p| {
            p.status
                .as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .map(|cs| cs.iter().map(|c| c.restart_count).sum::<i32>())
                .unwrap_or(0)
        })
        .expect("the wiki namespace has pods");

    let name = target.name_any();
    let cs = target.status.as_ref().and_then(|s| s.container_statuses.as_ref());
    let restarts: i32 = cs.map(|c| c.iter().map(|x| x.restart_count).sum()).unwrap_or(0);
    let container = cs.and_then(|c| c.first()).map(|c| c.name.clone()).unwrap_or_default();
    let running = cs
        .and_then(|c| c.first())
        .map(|c| c.state.as_ref().is_some_and(|s| s.running.is_some()))
        .unwrap_or(false);

    println!("pod        : wiki/{name}");
    println!("container  : {container}");
    println!("restarts   : {restarts}");
    println!("running now: {running}");

    // ---- current ----
    let current = read(&api, &name, &container, LogStreamOptions { tail: Some(5), ..Default::default() }).await?;
    println!("\n=== current, tail 5 ===\n{}", trim(&current));

    // ---- previous: the claim is that this returns and doesn't hang ----
    let started = std::time::Instant::now();
    let previous = read(
        &api,
        &name,
        &container,
        LogStreamOptions { tail: Some(5), previous: true, ..Default::default() },
    )
    .await?;
    println!("=== previous, tail 5 (returned in {:?}) ===\n{}", started.elapsed(), trim(&previous));

    // ---- since window ----
    let recent = read(&api, &name, &container, LogStreamOptions { since_seconds: Some(60), ..Default::default() }).await?;
    let all = read(&api, &name, &container, LogStreamOptions::default()).await?;
    println!("=== since=60s: {} lines   vs  no window: {} lines ===", recent.lines().count(), all.lines().count());

    // A previous read must terminate — that's what `follow: !previous` buys, and
    // it's the difference between a snapshot and a hung task.
    assert!(started.elapsed() < Duration::from_secs(20), "previous read must not hang");
    assert!(!previous.is_empty(), "a pod with restarts has a previous container");

    // The window must actually bound the output.
    assert!(
        recent.lines().count() <= all.lines().count(),
        "a 60s window cannot return more than the whole log"
    );

    // What this fixture can and can't show: while the container sits in
    // CrashLoopBackOff it isn't running, so `current` *already* returns the last
    // terminated container's output — the same bytes as `previous`. The two only
    // diverge once it restarts and is running again. Report which case we saw
    // rather than asserting a difference that depends on timing.
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

    // ---- export (B29): the whole log, not the ring buffer ----
    //
    // Against a *chatty* pod on purpose. The wiki crash-looper only prints ~38
    // lines per generation, so exporting it can't demonstrate the point of the
    // feature — which is recovering the part that already scrolled out of the
    // 200-line view. argocd's controller has tens of thousands.
    //
    // This exercises the same read + write `export_logs` performs; the command
    // itself needs a Tauri State that a harness can't construct.
    let chatty_ns = "argocd";
    let chatty_pod = "argocd-application-controller-0";
    let chatty: Api<Pod> = Api::namespaced(client.clone(), chatty_ns);
    let chatty_container = chatty
        .get(chatty_pod)
        .await?
        .spec
        .and_then(|s| s.containers.first().map(|c| c.name.clone()))
        .unwrap_or_default();

    let export_path = std::env::temp_dir().join("k7s-logs-check.log");
    let mut lp = log_params(&chatty_container, &LogStreamOptions::default());
    lp.follow = false;
    let whole = chatty.logs(chatty_pod, &lp).await?;
    std::fs::write(&export_path, &whole)?;
    let written = std::fs::read_to_string(&export_path)?;
    let line_count = written.lines().count();

    println!(
        "\n=== export {chatty_ns}/{chatty_pod}: {line_count} lines, {} bytes → {}",
        written.len(),
        export_path.display()
    );
    println!("    the view's ring buffer holds 200 — the file has {line_count}");
    assert_eq!(written, whole, "the file must be exactly what the API returned");
    assert!(
        line_count > 200,
        "the export must reach past the ring buffer, or it defeats its own purpose"
    );

    // And a window still bounds the export, so "last 5m" saves 5 minutes.
    let mut windowed = log_params(&chatty_container, &LogStreamOptions { since_seconds: Some(300), ..Default::default() });
    windowed.follow = false;
    let recent_text = chatty.logs(chatty_pod, &windowed).await?;
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
