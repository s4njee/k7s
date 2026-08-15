//! Live verification of the multi-cluster backend (B76):
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example multi_cluster_check
//!
//! Needs a kubeconfig with at least two contexts — the fixture cluster plus a
//! second (a scratch context into the same cluster counts: the point is two
//! separate connections, not two clusters). It connects both side-by-side,
//! proves they coexist, then disconnects one and checks the other's watchers
//! survive — the per-cluster lifecycle B76 exists for. Emit targets a mock
//! runtime, so this exercises the state machine and the real watchers, not the
//! wire.
//!
//! Cleanly skips (exit 0, with a note) when fewer than two contexts exist.

use k7s_lib::kube::client::{self, ClusterInfo};
use k7s_lib::kube::manager::ClientManager;
use k7s_lib::kube::{metrics, watchers};
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let contexts = client::list_contexts().unwrap_or_default();
    if contexts.len() < 2 {
        println!("need at least two kubeconfig contexts to exercise B76 (found {}); skipping", contexts.len());
        return Ok(());
    }

    let mgr = Arc::new(ClientManager::new(tauri::test::mock_app().handle().clone()));
    let cids: Vec<String> = contexts.iter().take(2).map(|c| c.name.clone()).collect();

    // Connect both side-by-side — no teardown of one when the other connects.
    for cid in &cids {
        let (kube_client, server) = client::build_client(cid).await?;
        let version = client::probe_version(&kube_client).await?;
        let watcher_count = watchers::spawn_all(mgr.clone(), cid.clone(), kube_client.clone()).await;
        let (metrics_task, status_task) = metrics::spawn_pollers(
            mgr.clone(),
            cid.clone(),
            kube_client.clone(),
            metrics::PollIntervals::default(),
        );
        mgr.push_task(cid.clone(), metrics_task).await;
        mgr.push_task(cid.clone(), status_task).await;
        let info = ClusterInfo {
            context: cid.clone(),
            cluster_name: cid.clone(),
            server,
            version,
        };
        mgr.set_connected(cid.clone(), kube_client, info, watcher_count).await;
        println!("connected {cid} — {watcher_count} watchers");
    }

    // Both coexist.
    assert!(mgr.is_connected(&cids[0]).await, "{0} should be connected", cids[0]);
    assert!(mgr.is_connected(&cids[1]).await, "{0} should be connected", cids[1]);
    println!("both connected simultaneously ✓");

    // Disconnect one; the other's connection and watchers survive.
    mgr.disconnect(&cids[0]).await;
    assert!(!mgr.is_connected(&cids[0]).await, "{0} should be torn down", cids[0]);
    assert!(mgr.is_connected(&cids[1]).await, "{1} must survive {0}'s disconnect", cids[0], cids[1]);
    println!("disconnected {0}; {1} still connected ✓", cids[0], cids[1]);

    mgr.disconnect(&cids[1]).await;
    println!("multi-cluster lifecycle OK: connect×2 → disconnect one → the other survives");
    Ok(())
}
