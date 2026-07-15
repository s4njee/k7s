//! Tauri commands invoked by the frontend. These are the only entry points from
//! the webview into Kubernetes. Live data (tables, metrics, status, logs) is
//! pushed back via events (see kube::events); these commands cover the one-shot
//! request/response operations plus starting/stopping log streams.

use crate::error::{AppError, AppResult};
use crate::kube::client::{self, ClusterInfo, ContextInfo};
use crate::kube::manager::ImportedContext;
use crate::kube::{logs, mappers, metrics, watchers, ClientManager};
use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, ListParams, PostParams};
use kube::ResourceExt;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::State;

/// Monotonic counter for generating unique log-stream ids.
static STREAM_SEQ: AtomicU64 = AtomicU64::new(1);

/// List kubeconfig contexts for the cluster switcher.
#[tauri::command]
pub fn list_contexts() -> AppResult<Vec<ContextInfo>> {
    client::list_contexts()
}

/// The default kubeconfig path (kubectl's), used to pre-point the import dialog.
#[tauri::command]
pub fn default_kubeconfig_path() -> String {
    client::default_kubeconfig_path()
}

/// Import contexts from a kubeconfig file at `path`. Records each context's source
/// file so it can be connected to later, and returns the merged switcher list
/// (default kubeconfig contexts + all imported ones, de-duplicated by name).
#[tauri::command]
pub async fn import_kubeconfig(
    path: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<Vec<ContextInfo>> {
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Parse the file and remember where each of its contexts came from.
    let imported = client::contexts_from_file(&path)?;
    for ctx in &imported {
        manager
            .add_import(
                ctx.name.clone(),
                ImportedContext { path: path.clone(), cluster: ctx.cluster.clone() },
            )
            .await;
    }

    Ok(merged_contexts(&manager).await)
}

/// Build the switcher list: default kubeconfig contexts plus every imported
/// context not already present (imported files never shadow the default).
async fn merged_contexts(manager: &ClientManager) -> Vec<ContextInfo> {
    let mut merged = client::list_contexts().unwrap_or_default();
    let existing: std::collections::HashSet<String> =
        merged.iter().map(|c| c.name.clone()).collect();
    for (name, imp) in manager.imports().await {
        if !existing.contains(&name) {
            merged.push(ContextInfo { name, cluster: imp.cluster, current: false });
        }
    }
    merged
}

/// Connect to a context: tear down any previous connection, build a client, probe
/// the version, then start all watchers and the metric/status pollers.
#[tauri::command]
pub async fn connect(
    context: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<ClusterInfo> {
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Abort every task from the previous connection first (Story 6.1).
    manager.reset().await;

    // If this context was imported from a specific file, build the client from
    // that file; otherwise use the default kubeconfig resolution.
    let (kube_client, server) = match manager.import_path(&context).await {
        Some(path) => client::build_client_from_file(&path, &context).await?,
        None => client::build_client(&context).await?,
    };
    let version = client::probe_version(&kube_client).await?;

    // Start watchers for all kinds and register their tasks.
    let watcher_count = watchers::spawn_all(&manager, kube_client.clone()).await;

    // Start the metrics + status pollers and register them too.
    let (metrics_task, status_task) = metrics::spawn_pollers(manager.app(), kube_client.clone());
    manager.push_task(metrics_task).await;
    manager.push_task(status_task).await;

    // Record the live connection (also emits the initial watch-status count).
    manager.set_connected(kube_client, watcher_count).await;

    Ok(ClusterInfo {
        context: context.clone(),
        cluster_name: context,
        server,
        version,
    })
}

/// Fetch an object's YAML for the detail panel (pods in v1). Strips
/// `metadata.managedFields`, which is noise for a human editor.
#[tauri::command]
pub async fn get_yaml(
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr).await?;
    if kind != "pods" {
        return Err(AppError::Other(format!("YAML view for '{kind}' is not supported yet")));
    }
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut pod = api.get(&name).await?;
    // Drop server-managed noise before rendering.
    pod.metadata.managed_fields = None;
    Ok(serde_yaml::to_string(&pod)?)
}

/// Apply edited YAML back to the cluster via replace (preserving resourceVersion
/// from the edited text). API errors are returned verbatim for inline display.
#[tauri::command]
pub async fn apply_yaml(
    kind: String,
    namespace: String,
    name: String,
    yaml: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr).await?;
    if kind != "pods" {
        return Err(AppError::Other(format!("YAML apply for '{kind}' is not supported yet")));
    }
    let pod: Pod = serde_yaml::from_str(&yaml)?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    // replace() requires the resourceVersion present in the fetched/edited object;
    // a stale value yields a 409 whose message we pass straight through.
    api.replace(&name, &PostParams::default(), &pod).await?;
    Ok(())
}

/// An event as shown in the detail panel's Events tab.
#[derive(Serialize)]
pub struct EventItem {
    #[serde(rename = "type")]
    type_: String,
    reason: String,
    message: String,
    count: i32,
    age: String,
}

/// List events for an object, newest first, field-selected by involvedObject.
#[tauri::command]
pub async fn get_events(
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<Vec<EventItem>> {
    let client = require_client(&mgr).await?;
    let api: Api<Event> = Api::namespaced(client, &namespace);
    let lp = ListParams::default().fields(&format!(
        "involvedObject.name={name},involvedObject.namespace={namespace}"
    ));
    let mut list = api.list(&lp).await?;

    // Sort newest-first by last-seen time (Reverse for descending).
    list.items.sort_by_key(|e| std::cmp::Reverse(last_seen(e)));

    let items = list
        .items
        .iter()
        .map(|e| EventItem {
            type_: e.type_.clone().unwrap_or_else(|| "Normal".into()),
            reason: e.reason.clone().unwrap_or_default(),
            message: e.message.clone().unwrap_or_default(),
            count: e.count.unwrap_or(1),
            age: event_age(e),
        })
        .collect();
    Ok(items)
}

/// Start following a container's logs; returns the new stream id.
#[tauri::command]
pub async fn start_log_stream(
    namespace: String,
    pod: String,
    container: String,
    tail: Option<i64>,
    since_time: Option<String>,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Unique id per stream (pod name + sequence).
    let stream_id = format!("{}-{}", pod, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let app = manager.app();

    let opts = logs::LogStreamOptions { tail, since_time };
    let id_for_task = stream_id.clone();
    let handle = tokio::spawn(async move {
        logs::run_log_stream(client, app, id_for_task, namespace, pod, container, opts).await;
    });

    manager.add_log(stream_id.clone(), handle).await;
    Ok(stream_id)
}

/// Stop a log stream (idempotent). Called on pause and panel close.
#[tauri::command]
pub async fn stop_log_stream(
    stream_id: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    mgr.remove_log(&stream_id).await;
    Ok(())
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/// Get the active client or a friendly "not connected" error.
async fn require_client(mgr: &ClientManager) -> AppResult<kube::Client> {
    mgr.client()
        .await
        .ok_or_else(|| AppError::NotFound("not connected to a cluster".into()))
}

/// Best "last seen" time for sorting: last_timestamp, else event_time, else epoch.
fn last_seen(e: &Event) -> chrono::DateTime<chrono::Utc> {
    if let Some(t) = &e.last_timestamp {
        return t.0;
    }
    if let Some(t) = &e.event_time {
        return t.0;
    }
    // Fall back to creation time or the epoch.
    e.creation_timestamp().map(|t| t.0).unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::UNIX_EPOCH)
}

/// Humanized age of an event's last occurrence (e.g. "2m").
fn event_age(e: &Event) -> String {
    let secs = (chrono::Utc::now() - last_seen(e)).num_seconds().max(0);
    mappers::humanize_duration(secs)
}
