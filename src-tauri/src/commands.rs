//! Tauri commands invoked by the frontend. These are the only entry points from
//! the webview into Kubernetes. Live data (tables, metrics, status, logs) is
//! pushed back via events (see kube::events); these commands cover the one-shot
//! request/response operations plus starting/stopping log streams.

use crate::error::{AppError, AppResult};
use crate::kube::client::{self, ClusterInfo, ContextInfo};
use crate::kube::manager::{ForwardDto, ImportedContext, ShellSession};
use crate::kube::{
    discovery, exec, logs, mappers, metrics, portforward, properties, watchers, ClientManager,
};
use tokio::sync::{mpsc, oneshot};
use k8s_openapi::api::core::v1::Event;
use kube::api::{
    Api, ApiResource, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
};
use kube::core::GroupVersionKind;
use kube::ResourceExt;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Emitter, State};

/// Monotonic counter for generating unique log-stream ids.
static STREAM_SEQ: AtomicU64 = AtomicU64::new(1);

/// Persisted UI preferences (B11): where the user left off. Written to
/// `<app_config_dir>/prefs.json`.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub context: Option<String>,
    pub nav: Option<String>,
    pub namespace: Option<String>,
    pub show_timestamps: Option<bool>,
    /// Kubeconfig files the user imported, re-imported on boot (B17).
    pub imported_files: Option<Vec<String>>,
}

/// Path to the prefs file under the app config dir (created on demand).
fn prefs_path(app: &tauri::AppHandle) -> AppResult<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("no config dir: {e}")))?;
    Ok(dir.join("prefs.json"))
}

/// Load persisted preferences, or None if absent/unreadable.
#[tauri::command]
pub fn load_prefs(app: tauri::AppHandle) -> Option<Prefs> {
    let path = prefs_path(&app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Save preferences (best-effort; creates the config dir if needed).
#[tauri::command]
pub fn save_prefs(app: tauri::AppHandle, prefs: Prefs) -> AppResult<()> {
    let path = prefs_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::write(path, text).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

/// List contexts for the cluster switcher: the default kubeconfig's plus any
/// imported ones (B17 — imports are restored on boot, so this must be merged or
/// they'd vanish on relaunch).
#[tauri::command]
pub async fn list_contexts(mgr: State<'_, Arc<ClientManager>>) -> AppResult<Vec<ContextInfo>> {
    Ok(merged_contexts(&mgr).await)
}

/// Re-register kubeconfig files imported in a previous session (B17), returning
/// the paths that still parse.
///
/// Files that have moved or become unreadable are dropped rather than failing the
/// boot: the user deleting a kubeconfig shouldn't leave the app stuck on an error
/// about it. The caller persists the returned list, which prunes them for good.
#[tauri::command]
pub async fn restore_imports(
    paths: Vec<String>,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<Vec<String>> {
    let manager: Arc<ClientManager> = (*mgr).clone();
    let mut alive = Vec::new();
    for path in paths {
        match client::contexts_from_file(&path) {
            Ok(contexts) => {
                for ctx in contexts {
                    manager
                        .add_import(
                            ctx.name.clone(),
                            ImportedContext { path: path.clone(), cluster: ctx.cluster.clone() },
                        )
                        .await;
                }
                alive.push(path);
            }
            Err(e) => tracing::warn!("dropping imported kubeconfig {path}: {e}"),
        }
    }
    Ok(alive)
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

    // Discover CRD-backed kinds and tell the frontend about them (B15). Their
    // watchers start lazily when the user opens one, so this only populates the
    // nav — a cluster with dozens of CRDs costs nothing until a kind is opened.
    let custom = discovery::discover(&kube_client).await;
    manager.set_custom_kinds(custom.clone()).await;
    let _ = manager.app().emit(crate::kube::events::CUSTOM_KINDS, custom);

    // Record the live connection (also emits the initial watch-status count).
    manager.set_connected(kube_client, watcher_count).await;

    Ok(ClusterInfo {
        context: context.clone(),
        cluster_name: context,
        server,
        version,
    })
}

/// Map a frontend kind id to its `ApiResource` and whether it is namespaced. The
/// kind id doubles as the resource plural, so we build the ApiResource directly
/// (avoiding fragile plural-guessing).
///
/// A custom (CRD-backed) kind id contains a slash ("group/plural", B15) and is
/// resolved from the kinds discovered on connect, so YAML/delete/events work on
/// CRDs through the same path as built-ins.
async fn resource_for(kind: &str, mgr: &ClientManager) -> AppResult<(ApiResource, bool)> {
    if kind.contains('/') {
        return match mgr.custom_kind(kind).await {
            Some(ck) => Ok((ck.api_resource(), ck.namespaced)),
            None => Err(AppError::Other(format!("unknown custom kind: {kind}"))),
        };
    }
    // (group, version, Kind, namespaced)
    let (group, version, k, namespaced) = match kind {
        "pods" => ("", "v1", "Pod", true),
        "deployments" => ("apps", "v1", "Deployment", true),
        "statefulsets" => ("apps", "v1", "StatefulSet", true),
        "daemonsets" => ("apps", "v1", "DaemonSet", true),
        "jobs" => ("batch", "v1", "Job", true),
        "cronjobs" => ("batch", "v1", "CronJob", true),
        "services" => ("", "v1", "Service", true),
        "ingresses" => ("networking.k8s.io", "v1", "Ingress", true),
        "configmaps" => ("", "v1", "ConfigMap", true),
        "secrets" => ("", "v1", "Secret", true),
        "nodes" => ("", "v1", "Node", false),
        "namespaces" => ("", "v1", "Namespace", false),
        other => return Err(AppError::Other(format!("unknown kind: {other}"))),
    };
    let gvk = GroupVersionKind::gvk(group, version, k);
    Ok((ApiResource::from_gvk_with_plural(&gvk, kind), namespaced))
}

/// Build a dynamic API for `kind`, namespaced or cluster-scoped as appropriate.
async fn dynamic_api(
    client: kube::Client,
    kind: &str,
    namespace: &str,
    mgr: &ClientManager,
) -> AppResult<Api<DynamicObject>> {
    let (ar, namespaced) = resource_for(kind, mgr).await?;
    Ok(if namespaced {
        Api::namespaced_with(client, namespace, &ar)
    } else {
        Api::all_with(client, &ar)
    })
}

/// Fetch an object's YAML for the detail panel (any kind). Strips
/// `metadata.managedFields`; Secret values are redacted (see below).
#[tauri::command]
pub async fn get_yaml(
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr).await?;
    let api = dynamic_api(client, &kind, &namespace, &mgr).await?;
    let mut obj = api.get(&name).await?;
    // Drop server-managed noise before rendering.
    obj.metadata.managed_fields = None;
    // Never surface Secret values; redact them for display (Secrets are read-only,
    // see apply_yaml). Documented in docs/verification.md.
    if kind == "secrets" {
        redact_secret(&mut obj);
    }
    Ok(serde_yaml::to_string(&obj)?)
}

/// Replace `data` values in a Secret with a placeholder so raw values never leave
/// the backend.
fn redact_secret(obj: &mut DynamicObject) {
    for field in ["data", "stringData"] {
        if let Some(serde_json::Value::Object(map)) = obj.data.get_mut(field) {
            for v in map.values_mut() {
                *v = serde_json::Value::String("<redacted>".into());
            }
        }
    }
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
    // Secrets are shown redacted, so applying edits would clobber their real values
    // — disallow it (the UI also hides the Edit button for Secrets).
    if kind == "secrets" {
        return Err(AppError::Other("editing Secrets is disabled".into()));
    }
    let obj: DynamicObject = serde_yaml::from_str(&yaml)?;
    let api = dynamic_api(client, &kind, &namespace, &mgr).await?;
    // replace() requires the resourceVersion present in the fetched/edited object;
    // a stale value yields a 409 whose message we pass straight through.
    api.replace(&name, &PostParams::default(), &obj).await?;
    Ok(())
}

/// Delete a resource of any kind. The frontend confirms first; API errors are
/// returned verbatim.
#[tauri::command]
pub async fn delete_resource(
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr).await?;
    let api = dynamic_api(client, &kind, &namespace, &mgr).await?;
    api.delete(&name, &DeleteParams::default()).await?;
    Ok(())
}

/// Scale a Deployment/StatefulSet by patching `spec.replicas`.
#[tauri::command]
pub async fn scale_resource(
    kind: String,
    namespace: String,
    name: String,
    replicas: i32,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr).await?;
    let api = dynamic_api(client, &kind, &namespace, &mgr).await?;
    let patch = Patch::Merge(serde_json::json!({ "spec": { "replicas": replicas } }));
    api.patch(&name, &PatchParams::default(), &patch).await?;
    Ok(())
}

/// Cordon or uncordon a node by patching `spec.unschedulable`.
#[tauri::command]
pub async fn set_cordon(
    name: String,
    unschedulable: bool,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr).await?;
    let api = dynamic_api(client, "nodes", "", &mgr).await?;
    let patch = Patch::Merge(serde_json::json!({ "spec": { "unschedulable": unschedulable } }));
    api.patch(&name, &PatchParams::default(), &patch).await?;
    Ok(())
}

/// Start watching a custom (CRD-backed) kind (B15), if it isn't already watched.
///
/// Called when the user opens a custom kind. Watching is lazy and reference-free:
/// a cluster can define hundreds of CRDs, and watching them all on connect would
/// open a stream per CRD for data nobody is looking at.
#[tauri::command]
pub async fn watch_custom_kind(kind: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    let manager: Arc<ClientManager> = (*mgr).clone();
    // Already open — nothing to do (navigating back to a kind is common).
    if manager.has_custom_watcher(&kind).await {
        return Ok(());
    }
    let client = require_client(&mgr).await?;
    let ck = manager
        .custom_kind(&kind)
        .await
        .ok_or_else(|| AppError::Other(format!("unknown custom kind: {kind}")))?;
    watchers::spawn_custom(&manager, client, &ck).await;
    Ok(())
}

/// Stop watching a custom kind (B15). Idempotent: unknown ids are a no-op, so the
/// frontend can call this unconditionally when navigating away.
#[tauri::command]
pub async fn unwatch_custom_kind(kind: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    mgr.remove_custom_watcher(&kind).await;
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

/// Gather an object's properties as a generic section document (B13, B18).
/// Errors for kinds with no gatherer — the frontend only offers the tab for the
/// kinds that have one.
#[tauri::command]
pub async fn get_properties(
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<properties::Properties> {
    let client = require_client(&mgr).await?;
    properties::gather(client, &kind, &namespace, &name).await
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
// Shell / exec (B4)
// --------------------------------------------------------------------------

/// Start an interactive shell in a pod container; returns the session id.
#[tauri::command]
pub async fn start_shell(
    namespace: String,
    pod: String,
    container: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    let id = format!("sh-{}-{}", pod, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>(8);
    let app = manager.app();
    let id_for_task = id.clone();
    let task = tokio::spawn(async move {
        exec::run_shell(client, app, id_for_task, namespace, pod, container, input_rx, resize_rx)
            .await;
    });

    manager
        .add_shell(id.clone(), ShellSession { task, input_tx, resize_tx })
        .await;
    Ok(id)
}

/// Send keystrokes to a shell session.
#[tauri::command]
pub async fn shell_input(
    stream_id: String,
    data: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    mgr.shell_input(&stream_id, data.into_bytes()).await;
    Ok(())
}

/// Resize a shell session's terminal.
#[tauri::command]
pub async fn shell_resize(
    stream_id: String,
    cols: u16,
    rows: u16,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    mgr.shell_resize(&stream_id, cols, rows).await;
    Ok(())
}

/// Stop a shell session (idempotent).
#[tauri::command]
pub async fn stop_shell(stream_id: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    mgr.remove_shell(&stream_id).await;
    Ok(())
}

// --------------------------------------------------------------------------
// Port-forwarding (B6, B16)
// --------------------------------------------------------------------------

/// Start forwarding a pod port to a local TCP port; returns the forward (with the
/// chosen local port). Errors if the pod doesn't exist or the listener can't bind.
#[tauri::command]
pub async fn start_port_forward(
    namespace: String,
    pod: String,
    remote_port: u16,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<ForwardDto> {
    let client = require_client(&mgr).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Fail fast with a clear message if the pod is gone.
    portforward::ensure_pod(client.clone(), &namespace, &pod).await?;

    spawn_forward(manager, client, namespace, pod, None, remote_port).await
}

/// Start forwarding a *Service* port (B16): pick a Ready backing pod and resolve
/// the service port's targetPort, then forward to that pod exactly as above.
///
/// This is what `kubectl port-forward svc/x` does — Kubernetes has no service-level
/// forward — so the forward follows one pod and does not load-balance.
#[tauri::command]
pub async fn start_service_port_forward(
    namespace: String,
    service: String,
    remote_port: u16,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<ForwardDto> {
    let client = require_client(&mgr).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    let (pod, target_port) =
        portforward::resolve_service(client.clone(), &namespace, &service, remote_port).await?;

    spawn_forward(manager, client, namespace, pod, Some(service), target_port).await
}

/// Bind a local listener, spawn the forward's accept loop, and register it.
/// Shared by the pod and Service paths — by this point a Service forward *is* a
/// pod forward.
async fn spawn_forward(
    manager: Arc<ClientManager>,
    client: kube::Client,
    namespace: String,
    pod: String,
    service: Option<String>,
    remote_port: u16,
) -> AppResult<ForwardDto> {
    let (ready_tx, ready_rx) = oneshot::channel::<Result<u16, String>>();
    // Bounded: per-connection errors are for display, so a full channel just means
    // the failure is already reported.
    let (err_tx, mut err_rx) = mpsc::channel::<String>(8);

    let ns = namespace.clone();
    let p = pod.clone();
    let task = tokio::spawn(async move {
        portforward::run_port_forward(client, ns, p, remote_port, ready_tx, err_tx).await;
    });

    // Wait for the listener to bind (or report the bind error).
    let local_port = ready_rx
        .await
        .map_err(|_| AppError::Other("port-forward task ended before binding".into()))?
        .map_err(AppError::Kube)?;

    let label = service.clone().unwrap_or_else(|| pod.clone());
    let id = format!("pf-{}-{}", label, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let dto =
        ForwardDto { id: id.clone(), namespace, pod, service, remote_port, local_port, error: None };
    manager.add_forward(dto.clone(), task).await;

    // Relay per-connection failures onto the forward for the UI. Ends on its own
    // when the forward task is aborted and drops the sender.
    let relay_mgr = manager.clone();
    let relay = tokio::spawn(async move {
        while let Some(e) = err_rx.recv().await {
            relay_mgr.set_forward_error(&id, e).await;
        }
    });
    manager.push_task(relay).await;

    Ok(dto)
}

/// Stop a port-forward (idempotent).
#[tauri::command]
pub async fn stop_port_forward(id: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    mgr.remove_forward(&id).await;
    Ok(())
}

/// List active port-forwards.
#[tauri::command]
pub async fn list_port_forwards(mgr: State<'_, Arc<ClientManager>>) -> AppResult<Vec<ForwardDto>> {
    Ok(mgr.list_forwards().await)
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
