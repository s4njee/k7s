//! Per-kind watchers. Each kind gets a task that drives a `kube` reflector (so a
//! local store stays current, including deletes) and emits a *full row snapshot*
//! for that kind, debounced to at most once per [`DEBOUNCE`]. Snapshots are
//! idempotent, which avoids any delta-reconciliation bugs in the UI.
//!
//! A watcher that fails (e.g. RBAC forbids a kind) logs and — thanks to
//! `default_backoff` — keeps retrying without affecting the other eleven kinds.

use super::{dto::Row, events, mappers, ClientManager, ResourceKind, ResourceUpdate};
use futures::StreamExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Node, Pod, Secret, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::runtime::reflector::Lookup;
use kube::runtime::{reflector, watcher, WatchStreamExt};
use kube::{Api, Client, Resource};
use serde::de::DeserializeOwned;
use std::fmt::Debug;
use tauri::{AppHandle, Emitter};
use tokio::time::{interval, Duration, MissedTickBehavior};

/// Maximum snapshot emit rate per kind (coalesces bursts of watch events).
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Start watchers for all twelve kinds and register their tasks with the manager
/// so they are aborted on disconnect/context-switch. Returns the number started.
pub async fn spawn_all(mgr: &ClientManager, client: Client) -> usize {
    // Each line pairs a typed resource with its mapper (the column contract).
    spawn::<Pod>(mgr, &client, ResourceKind::Pods, mappers::map_pod).await;
    spawn::<Deployment>(mgr, &client, ResourceKind::Deployments, mappers::map_deployment).await;
    spawn::<StatefulSet>(mgr, &client, ResourceKind::Statefulsets, mappers::map_statefulset).await;
    spawn::<DaemonSet>(mgr, &client, ResourceKind::Daemonsets, mappers::map_daemonset).await;
    spawn::<Job>(mgr, &client, ResourceKind::Jobs, mappers::map_job).await;
    spawn::<CronJob>(mgr, &client, ResourceKind::Cronjobs, mappers::map_cronjob).await;
    spawn::<Service>(mgr, &client, ResourceKind::Services, mappers::map_service).await;
    spawn::<Ingress>(mgr, &client, ResourceKind::Ingresses, mappers::map_ingress).await;
    spawn::<ConfigMap>(mgr, &client, ResourceKind::Configmaps, mappers::map_configmap).await;
    spawn::<Secret>(mgr, &client, ResourceKind::Secrets, mappers::map_secret).await;
    spawn::<Node>(mgr, &client, ResourceKind::Nodes, mappers::map_node).await;
    spawn::<Namespace>(mgr, &client, ResourceKind::Namespaces, mappers::map_namespace).await;
    12
}

/// Spawn one watcher task and register it with the manager.
async fn spawn<K>(
    mgr: &ClientManager,
    client: &Client,
    kind: ResourceKind,
    map_fn: fn(&K) -> Row,
) where
    // All twelve are concrete typed resources whose DynamicType (for both the
    // Resource and Lookup traits) is the unit type; pinning it to () disambiguates
    // the two associated types and satisfies the Default/Eq/Hash/Clone/Send bounds
    // required by Api::all, watcher(), and reflector::store().
    K: Resource<DynamicType = ()>
        + Lookup<DynamicType = ()>
        + Clone
        + DeserializeOwned
        + Debug
        + Send
        + Sync
        + 'static,
{
    let app = mgr.app();
    let client = client.clone();
    let handle = tokio::spawn(async move {
        run_watcher::<K>(client, app, kind, map_fn).await;
    });
    mgr.push_task(handle).await;
}

/// Drive a reflector for `K` and emit debounced snapshots for `kind`.
async fn run_watcher<K>(client: Client, app: AppHandle, kind: ResourceKind, map_fn: fn(&K) -> Row)
where
    // Pin both DynamicType assoc types to () (see spawn()'s bound for why).
    K: Resource<DynamicType = ()>
        + Lookup<DynamicType = ()>
        + Clone
        + DeserializeOwned
        + Debug
        + Send
        + Sync
        + 'static,
{
    // Cluster-wide watch for this kind.
    let api: Api<K> = Api::all(client);
    let (reader, writer) = reflector::store::<K>();

    // reflector() writes every event into the store and passes it through; the
    // store therefore reflects adds *and* deletes. default_backoff() retries on
    // transient/permission errors instead of terminating the stream.
    let mut stream = reflector(writer, watcher(api, watcher::Config::default()))
        .default_backoff()
        .boxed();

    // A ticker gates emits to at most one per DEBOUNCE window.
    let mut ticker = interval(DEBOUNCE);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut dirty = false;
    loop {
        tokio::select! {
            // A watch event arrived; the store is already updated. Mark dirty so the
            // next tick emits a fresh snapshot.
            ev = stream.next() => match ev {
                Some(Ok(_)) => { dirty = true; }
                Some(Err(e)) => {
                    // Logged, not fatal — backoff will retry this one kind.
                    tracing::warn!("watch {} error: {e}", kind.id());
                }
                None => break, // stream ended (client dropped on reset)
            },
            // Debounce window elapsed; emit if anything changed.
            _ = ticker.tick() => {
                if dirty {
                    dirty = false;
                    let rows: Vec<Row> = reader.state().iter().map(|o| map_fn(o.as_ref())).collect();
                    // Emit failures are non-fatal (webview may be gone).
                    let _ = app.emit(events::RESOURCE_UPDATE, ResourceUpdate { kind, rows });
                }
            }
        }
    }
}
