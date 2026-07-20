//! Tauri commands invoked by the frontend. These are the only entry points from
//! the webview into Kubernetes. Live data (tables, metrics, status, logs) is
//! pushed back via events (see kube::events); these commands cover the one-shot
//! request/response operations plus starting/stopping log streams.

use crate::error::{AppError, AppResult};
use crate::kube::client::{self, ClusterInfo, ContextInfo};
use crate::kube::manager::{ForwardDto, ImportedContext, ShellSession};
use crate::kube::{
    discovery, drain, exec, exporter, helm, logs, mappers, metrics, nodeshell, nodestats,
    portforward, promql, properties, restart, watchers, ClientManager, ResourceKind,
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
    // ---- settings (B23) ----
    /// Seconds between metrics polls; None uses the built-in default.
    pub metrics_interval_secs: Option<u64>,
    /// Seconds between cluster-status polls; None uses the built-in default.
    pub status_interval_secs: Option<u64>,
    /// Shell command override for exec; None/empty uses the bash-or-sh probe.
    pub shell_command: Option<String>,
    // The two below are never read here — they're the frontend's business. They
    // exist because `save_prefs` round-trips the frontend's object *through this
    // struct*, and serde drops fields it doesn't know about. Leaving them out
    // doesn't "let the frontend own them"; it silently deletes them on the first
    // save, which is exactly what happened before this was written down.
    //
    // So: this struct is the schema of prefs.json, not just the part Rust uses.
    // A new frontend-only setting must be added here too.
    /// Log ring-buffer size. Frontend-only; carried so it survives a save.
    pub log_buffer_cap: Option<u32>,
    /// Namespace selected on connect. Frontend-only; carried so it survives a save.
    pub default_namespace: Option<String>,
    /// Colour palette ("dark"/"light"/"system"). Frontend-only; carried so it
    /// survives a save (B52).
    pub theme: Option<String>,
    /// Container image for the node debug shell; None/empty uses the default (B53).
    pub node_shell_image: Option<String>,
}

/// Read persisted prefs, or defaults when absent/unreadable.
///
/// The backend reads the same prefs file the frontend writes rather than having
/// settings passed in per call: there's then exactly one copy of the truth, and
/// no way for a command to be invoked with settings that disagree with what the
/// user last saved.
fn read_prefs(app: &tauri::AppHandle) -> Prefs {
    prefs_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Poll intervals from prefs, clamped to the same bounds the settings panel
/// enforces — a hand-edited prefs.json shouldn't be able to hammer the API server.
fn poll_intervals(app: &tauri::AppHandle) -> metrics::PollIntervals {
    let prefs = read_prefs(app);
    let clamp = |v: Option<u64>, default: std::time::Duration| {
        v.map(|s| std::time::Duration::from_secs(s.clamp(5, 300))).unwrap_or(default)
    };
    metrics::PollIntervals {
        metrics: clamp(prefs.metrics_interval_secs, metrics::METRICS_INTERVAL),
        status: clamp(prefs.status_interval_secs, metrics::STATUS_INTERVAL),
    }
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
    // Poll intervals come from the user's settings (B23). Read at connect, so a
    // change takes effect on the next connection rather than restarting live
    // pollers for a value measured in seconds.
    let (metrics_task, status_task) =
        metrics::spawn_pollers(manager.app(), kube_client.clone(), poll_intervals(&manager.app()));
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
        "replicasets" => ("apps", "v1", "ReplicaSet", true),
        "statefulsets" => ("apps", "v1", "StatefulSet", true),
        "daemonsets" => ("apps", "v1", "DaemonSet", true),
        "jobs" => ("batch", "v1", "Job", true),
        "cronjobs" => ("batch", "v1", "CronJob", true),
        "services" => ("", "v1", "Service", true),
        "ingresses" => ("networking.k8s.io", "v1", "Ingress", true),
        "ingressclasses" => ("networking.k8s.io", "v1", "IngressClass", false),
        "configmaps" => ("", "v1", "ConfigMap", true),
        "secrets" => ("", "v1", "Secret", true),
        "serviceaccounts" => ("", "v1", "ServiceAccount", true),
        "persistentvolumeclaims" => ("", "v1", "PersistentVolumeClaim", true),
        "persistentvolumes" => ("", "v1", "PersistentVolume", false),
        "storageclasses" => ("storage.k8s.io", "v1", "StorageClass", false),
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

/// The rendered manifest of a Helm release, newest revision (B26).
///
/// Finds the release by label rather than reconstructing the Secret's name:
/// `sh.helm.release.v1.<name>.v<revision>` requires knowing the revision, and the
/// labels are what Helm itself queries on.
async fn helm_manifest(client: kube::Client, namespace: &str, name: &str) -> AppResult<String> {
    let api: Api<k8s_openapi::api::core::v1::Secret> = Api::namespaced(client, namespace);
    let lp = ListParams::default()
        .fields(&format!("type={}", helm::RELEASE_SECRET_TYPE))
        .labels(&format!("name={name},owner=helm"));
    let list = api.list(&lp).await?;

    let latest = list
        .items
        .iter()
        .filter_map(helm::decode_release)
        .max_by_key(|r| r.revision)
        .ok_or_else(|| AppError::NotFound(format!("helm release {name} not found in {namespace}")))?;

    if latest.manifest.trim().is_empty() {
        return Err(AppError::Other(format!("release {name} has no rendered manifest")));
    }
    Ok(latest.manifest)
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
    // A Helm release isn't an API object, so there's nothing to GET: its YAML is
    // the manifest the chart rendered, which is what you actually want to read
    // (B26). Secret values in it are already redacted by the decoder.
    if kind == ResourceKind::Helm.id() {
        return helm_manifest(client, &namespace, &name).await;
    }
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
    ensure_writable(&kind)?;
    let obj: DynamicObject = serde_yaml::from_str(&yaml)?;
    let api = dynamic_api(client, &kind, &namespace, &mgr).await?;
    // replace() requires the resourceVersion present in the fetched/edited object;
    // a stale value yields a 409 whose message we pass straight through.
    api.replace(&name, &PostParams::default(), &obj).await?;
    Ok(())
}

/// Refuse the two kinds whose YAML must never be written back.
///
/// Shared by `apply_yaml` and `dry_run_yaml` so the two can't drift — a dry run
/// that succeeded on a kind the real apply then refuses would be worse than no
/// preview at all.
fn ensure_writable(kind: &str) -> AppResult<()> {
    // A Helm release's YAML is a *rendered* manifest, not an API object: applying
    // it would bypass Helm and desync the release from what Helm believes it
    // deployed. B26 is read-only by design.
    if kind == ResourceKind::Helm.id() {
        return Err(AppError::Other(
            "Helm releases are read-only here — use `helm upgrade` to change one".into(),
        ));
    }
    // Secrets are shown redacted, so applying edits would clobber their real values
    // — disallow it (the UI also hides the Edit button for Secrets).
    if kind == "secrets" {
        return Err(AppError::Other("editing Secrets is disabled".into()));
    }
    Ok(())
}

/// What a proposed edit would actually do, as the *server* sees it (B36).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YamlDiff {
    /// The live object now.
    pub current: String,
    /// What would be stored if this were applied — after defaulting and any
    /// mutating webhooks.
    pub proposed: String,
}

/// Send an edit as a server-side dry run and return both sides for a diff (B36).
///
/// `dryRun=All` runs the whole admission chain — validation, defaulting, mutating
/// webhooks — and returns the object that *would* be persisted, without
/// persisting it. That's the only way to show what an apply will really do:
/// defaulted fields and webhook rewrites are invisible in the text you typed.
///
/// Both sides are serialized through the same path as `get_yaml` (managedFields
/// dropped, same serializer) so the diff shows real changes rather than
/// formatting noise.
#[tauri::command]
pub async fn dry_run_yaml(
    kind: String,
    namespace: String,
    name: String,
    yaml: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<YamlDiff> {
    let client = require_client(&mgr).await?;
    ensure_writable(&kind)?;
    let obj: DynamicObject = serde_yaml::from_str(&yaml)?;
    let api = dynamic_api(client, &kind, &namespace, &mgr).await?;

    let mut current = api.get(&name).await?;
    current.metadata.managed_fields = None;

    // A rejected dry run is the point, not a failure of this command: the caller
    // shows the server's message instead of a diff, and nothing was written.
    let pp = PostParams { dry_run: true, ..Default::default() };
    let mut proposed = api.replace(&name, &pp, &obj).await?;
    proposed.metadata.managed_fields = None;

    Ok(YamlDiff {
        current: serde_yaml::to_string(&current)?,
        proposed: serde_yaml::to_string(&proposed)?,
    })
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

/// Restart a pod (B34) by deleting it so its controller recreates a fresh one.
///
/// Refuses a pod with no controlling owner: deleting *that* would just remove it,
/// which is a delete, not a restart. The check happens here, where we have the
/// full object, rather than trusting the frontend to have hidden the action.
#[tauri::command]
pub async fn restart_pod(
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr).await?;
    let api: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);
    let pod = api.get(&name).await?;
    if !restart::has_controller(&pod) {
        return Err(AppError::Other(format!(
            "{name} has no controller — deleting it would not recreate it. Use Delete instead."
        )));
    }
    api.delete(&name, &DeleteParams::default()).await?;
    Ok(())
}

/// Rollout-restart a Deployment/StatefulSet/DaemonSet (B34) the way `kubectl
/// rollout restart` does: patch the pod template's `restartedAt` annotation to
/// now, which the controller rolls through its normal update strategy.
#[tauri::command]
pub async fn restart_rollout(
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    if !restart::is_rollout_kind(&kind) {
        return Err(AppError::Other(format!("{kind} cannot be rollout-restarted")));
    }
    let client = require_client(&mgr).await?;
    let api = dynamic_api(client, &kind, &namespace, &mgr).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let patch = Patch::Merge(restart::restart_patch(&now));
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

/// Drain a node (B20): cordon it, then evict its pods in the background.
///
/// Cordoning happens inline so an RBAC/not-found failure surfaces as a rejected
/// command rather than a silent no-op. The eviction pass then runs as a
/// connection-scoped task reporting via [`kube::events::DRAIN_PROGRESS`] — it can
/// take minutes, so blocking the command on it would freeze the UI.
#[tauri::command]
pub async fn drain_node(name: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    let client = require_client(&mgr).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Cordon first: without it the scheduler could refill the node as we drain it.
    drain::cordon(client.clone(), &name).await?;

    let app = manager.app();
    let task = tokio::spawn(async move {
        drain::run_drain(client, app, name).await;
    });
    manager.push_task(task).await;
    Ok(())
}

/// Backfill a node's charts from Prometheus (B38), or an empty list when the
/// cluster has no Prometheus we recognise.
///
/// Empty is a normal answer, not an error: B27's live scraper is the source of
/// truth and works without any of this, so a cluster with no Prometheus (or one
/// whose scrape targets have drifted) simply opens the charts empty and fills
/// them as it goes, exactly as before.
#[tauri::command]
pub async fn node_history(
    node: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<Vec<exporter::NodeSample>> {
    let client = require_client(&mgr).await?;
    let Some(svc) = promql::discover(&client).await else {
        return Ok(Vec::new());
    };
    let now = chrono::Utc::now().timestamp();
    // An hour at 30s is 120 points — enough to open with a populated chart
    // without crowding out the live samples that follow (the series is capped).
    promql::node_history(&client, &svc, &node, now, 3600, 30).await
}

/// Start scraping a node's node-exporter for plots (B27), if not already running.
///
/// Called when a node's Metrics tab opens. Lazy for the same reason CRD watchers
/// are: each scrape moves a few hundred KB and holds a port-forward, which is not
/// something to run for every node in the background.
#[tauri::command]
pub async fn watch_node_stats(node: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    let manager: Arc<ClientManager> = (*mgr).clone();
    if manager.has_node_scraper(&node).await {
        return Ok(());
    }
    let client = require_client(&mgr).await?;
    let app = manager.app();
    // Reuses the metrics poll interval from settings (B23): it's the same question
    // ("how often should we ask the cluster how it's doing"), so it would be odd
    // for the plots to march to a different drum than the table's CPU column.
    let every = poll_intervals(&app).metrics;
    let n = node.clone();
    let task = tokio::spawn(async move {
        nodestats::run_node_stats(client, app, n, every).await;
    });
    manager.add_node_scraper(node, task).await;
    Ok(())
}

/// Stop scraping a node (B27). Idempotent, so the frontend can call it
/// unconditionally when the tab closes; drops the port-forward with it.
#[tauri::command]
pub async fn unwatch_node_stats(node: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    mgr.remove_node_scraper(&node).await;
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
#[allow(clippy::too_many_arguments)]
pub async fn start_log_stream(
    namespace: String,
    pod: String,
    container: String,
    tail: Option<i64>,
    since_time: Option<String>,
    since_seconds: Option<i64>,
    previous: bool,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Unique id per stream (pod name + sequence).
    let stream_id = format!("{}-{}", pod, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let app = manager.app();

    let opts = logs::LogStreamOptions { tail, since_time, since_seconds, previous };
    let id_for_task = stream_id.clone();
    let handle = tokio::spawn(async move {
        logs::run_log_stream(client, app, id_for_task, namespace, pod, container, opts).await;
    });

    manager.add_log(stream_id.clone(), handle).await;
    Ok(stream_id)
}

/// Write a pod's full logs to `path` (B29).
///
/// Deliberately not "save what's on screen": the view holds a ring buffer of the
/// last few hundred lines, and the reason you're exporting is usually that you
/// want the part that scrolled away. This re-reads with no tail cap.
///
/// The backend writes the file itself rather than handing the text back for the
/// frontend to save — a container's whole log can be tens of megabytes, and
/// there's no reason to move that through the IPC bridge and into the webview's
/// heap just to write it straight back out to disk.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_logs(
    namespace: String,
    pod: String,
    container: String,
    since_seconds: Option<i64>,
    previous: bool,
    path: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<usize> {
    let client = require_client(&mgr).await?;
    let api: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), &namespace);

    // No tail: the whole thing. No follow: this must terminate.
    let opts = logs::LogStreamOptions { tail: None, since_time: None, since_seconds, previous };

    // An empty container means "all of them" (B7), so the export mirrors what the
    // view interleaves — one block per container, labelled, rather than a soup of
    // lines whose origin the file can't show.
    let containers = if container.is_empty() {
        let p = api.get(&pod).await.map_err(|e| AppError::Kube(e.to_string()))?;
        p.spec
            .map(|s| s.containers.into_iter().map(|c| c.name).collect::<Vec<_>>())
            .unwrap_or_default()
    } else {
        vec![container]
    };

    let mut out = String::new();
    for name in &containers {
        let mut lp = logs::log_params(name, &opts);
        // log_params follows unless reading `previous`; an export must always end.
        lp.follow = false;
        let text = api.logs(&pod, &lp).await.map_err(|e| AppError::Kube(e.to_string()))?;
        if containers.len() > 1 {
            out.push_str(&format!("===== container: {name} =====\n"));
        }
        out.push_str(&text);
        if !text.ends_with('\n') {
            out.push('\n');
        }
    }

    let lines = out.lines().count();
    std::fs::write(&path, out).map_err(|e| AppError::Other(format!("could not write {path}: {e}")))?;
    Ok(lines)
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
    // Read per-session, so changing the override applies to the next shell you
    // open rather than needing a reconnect (B23).
    let shell_override = read_prefs(&app).shell_command.unwrap_or_default();
    let id_for_task = id.clone();
    let task = tokio::spawn(async move {
        exec::run_shell(
            client,
            app,
            id_for_task,
            namespace,
            pod,
            container,
            shell_override,
            input_rx,
            resize_rx,
        )
        .await;
    });

    manager
        .add_shell(id.clone(), ShellSession { task, input_tx, resize_tx })
        .await;
    Ok(id)
}

// --------------------------------------------------------------------------
// Node debug shell (B53)
// --------------------------------------------------------------------------

/// What the frontend needs to drive and clean up a node shell session.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeShellInfo {
    pub stream_id: String,
    pub namespace: String,
    /// Surfaced in the UI so the pod is never invisible: if cleanup somehow fails,
    /// the user has the exact name to delete by hand.
    pub pod: String,
}

/// How long to wait for the debug pod before giving up and explaining why.
///
/// Generous, because the first run on a node pulls the image over whatever link
/// the node has. Bounded, because a NotReady node will never start it at all and
/// waiting forever just looks like a hang.
const NODE_SHELL_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// Wait for the debug pod to reach Running, or explain what it's stuck on.
async fn await_debug_pod(api: &Api<k8s_openapi::api::core::v1::Pod>, name: &str) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + NODE_SHELL_READY_TIMEOUT;
    let mut last = String::from("the pod was never observed");
    while tokio::time::Instant::now() < deadline {
        let pod = api.get(name).await?;
        let status = pod.status.unwrap_or_default();
        let phase = status.phase.clone().unwrap_or_default();
        if phase == "Running" {
            return Ok(());
        }
        // A container waiting reason (ImagePullBackOff, CreateContainerError) is far
        // more actionable than the phase, so prefer it when there is one.
        let waiting = status
            .container_statuses
            .as_ref()
            .and_then(|cs| cs.first())
            .and_then(|c| c.state.as_ref())
            .and_then(|s| s.waiting.as_ref())
            .map(|w| {
                (
                    w.reason.clone().unwrap_or_default(),
                    w.message.clone().unwrap_or_default(),
                )
            });
        last = nodeshell::pending_reason(&phase, waiting.as_ref().map(|(r, m)| (r.as_str(), m.as_str())));
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    }
    Err(AppError::Other(format!("timed out starting the debug pod: {last}")))
}

/// Delete a debug pod, best effort. Used by both the sweep and session teardown.
async fn delete_debug_pod(api: &Api<k8s_openapi::api::core::v1::Pod>, name: &str) {
    // Grace period 0: there is nothing to flush, and every second it lingers is a
    // second a privileged pod is still on the node.
    let dp = DeleteParams { grace_period_seconds: Some(0), ..Default::default() };
    if let Err(e) = api.delete(name, &dp).await {
        tracing::warn!("failed to delete debug pod {name}: {e}");
    }
}

/// Open a root shell on a node's host OS (B53).
///
/// This creates a privileged pod — see kube/nodeshell.rs for what that grants and
/// why each piece is needed. It is only ever called from an explicit user action.
#[tauri::command]
pub async fn start_node_shell(
    node: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<NodeShellInfo> {
    let client = require_client(&mgr).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();
    let api: Api<k8s_openapi::api::core::v1::Pod> =
        Api::namespaced(client.clone(), nodeshell::DEBUG_NAMESPACE);

    // Sweep this node's leftovers first. A previous session that died without
    // cleaning up would otherwise collide on the name or, worse, quietly leave a
    // privileged pod running alongside the new one.
    if let Ok(old) = api
        .list(&ListParams::default().labels(&nodeshell::node_selector(&node)))
        .await
    {
        for pod in old.items {
            delete_debug_pod(&api, &pod.name_any()).await;
        }
    }

    let seq = STREAM_SEQ.fetch_add(1, Ordering::Relaxed);
    let pod_name = nodeshell::pod_name(&node, seq);
    let app = manager.app();
    let image = read_prefs(&app)
        .node_shell_image
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| nodeshell::DEFAULT_IMAGE.to_string());

    api.create(&PostParams::default(), &nodeshell::debug_pod_spec(&node, &image, &pod_name))
        .await?;

    // From here on the pod exists, so any failure must clean up after itself rather
    // than leave a privileged pod behind on the strength of an error return.
    if let Err(e) = await_debug_pod(&api, &pod_name).await {
        delete_debug_pod(&api, &pod_name).await;
        return Err(e);
    }

    let id = format!("nsh-{pod_name}");
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>(8);
    let id_for_task = id.clone();
    let pod_for_task = pod_name.clone();
    let task = tokio::spawn(async move {
        exec::run_argv(
            client,
            app,
            id_for_task,
            nodeshell::DEBUG_NAMESPACE.to_string(),
            pod_for_task,
            "debug".to_string(),
            nodeshell::nsenter_cmd(),
            input_rx,
            resize_rx,
        )
        .await;
    });

    manager.add_shell(id.clone(), ShellSession { task, input_tx, resize_tx }).await;
    Ok(NodeShellInfo {
        stream_id: id,
        namespace: nodeshell::DEBUG_NAMESPACE.to_string(),
        pod: pod_name,
    })
}

/// Stop a node shell and delete its pod (idempotent).
///
/// Deliberately separate from `stop_shell`: that only aborts the pump task, and an
/// aborted task cannot run async cleanup on the way out. Deleting here — outside
/// the task — is what makes teardown actually reliable. The pod's
/// `activeDeadlineSeconds` remains the backstop for the case where this never runs
/// at all.
#[tauri::command]
pub async fn stop_node_shell(
    stream_id: String,
    pod: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    mgr.remove_shell(&stream_id).await;
    if let Some(client) = mgr.client().await {
        let api: Api<k8s_openapi::api::core::v1::Pod> =
            Api::namespaced(client, nodeshell::DEBUG_NAMESPACE);
        delete_debug_pod(&api, &pod).await;
    }
    Ok(())
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

    spawn_forward(manager, client, namespace, pod, Some((service, remote_port)), target_port).await
}

/// Bind a local listener, spawn the forward's accept loop, and register it.
/// Shared by the pod and Service paths — by this point a Service forward *is* a
/// pod forward.
async fn spawn_forward(
    manager: Arc<ClientManager>,
    client: kube::Client,
    namespace: String,
    pod: String,
    // For a Service forward: its name and the port the user asked for.
    service: Option<(String, u16)>,
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

    let (service_name, service_port) = match service {
        // Only carry the service port when it differs; an identical one is noise.
        Some((name, port)) => (Some(name), (port != remote_port).then_some(port)),
        None => (None, None),
    };
    let label = service_name.clone().unwrap_or_else(|| pod.clone());
    let id = format!("pf-{}-{}", label, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let dto = ForwardDto {
        id: id.clone(),
        namespace,
        pod,
        service: service_name,
        remote_port,
        service_port,
        local_port,
        error: None,
    };
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
