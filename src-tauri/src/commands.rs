//! Tauri commands invoked by the frontend. These are the only entry points from
//! the webview into Kubernetes. Live data (tables, metrics, status, logs) is
//! pushed back via events (see kube::events); these commands cover the one-shot
//! request/response operations plus starting/stopping log streams.

use crate::crash_reporting;
use crate::diagnostics;
use crate::error::{AppError, AppResult};
use crate::kube::client::{self, ClusterInfo, ContextInfo};
use crate::logging;
use crate::kube::manager::{ForwardDto, ImportedContext, ShellSession};
use crate::kube::{
    batch, discovery, drain, exec, exporter, helm, logs, mappers, metrics, nodeshell, nodestats,
    overview, portforward, promql, properties, restart, topology, watchers, Cid, ClientManager,
    ResourceKind,
};
use tokio::sync::{mpsc, oneshot};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::Event;
use crate::kube::dto::EventInvolved;
use kube::api::{
    Api, ApiResource, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
};
use kube::core::GroupVersionKind;
use kube::ResourceExt;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::State;

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
    /// UI font ("mono"/"sans"). Frontend-only; carried so it survives a save.
    pub ui_font: Option<String>,
    /// Accent colour ("blue"/"green"/"purple"/"orange"). Frontend-only; carried
    /// so it survives a save.
    pub accent: Option<String>,
    /// Disable the pulsing "live" dot and other motion. Frontend-only.
    pub reduce_motion: Option<bool>,
    /// Native problem notifications (B50). Frontend-only.
    pub notifications: Option<bool>,
    /// Resource bookmarks (B56), keyed by context. Frontend-owned, so it's
    /// carried as an opaque JSON value to round-trip through saves.
    pub bookmarks: Option<serde_json::Value>,
    /// Container image for the node debug shell; None/empty uses the default (B53).
    pub node_shell_image: Option<String>,
    // ---- diagnostics (B73) ----
    /// Backend log verbosity, one of logging::LEVELS. Applied to the tracing
    /// filter at boot and reloaded on save — no restart to capture a crash-loop.
    pub log_level: Option<String>,
    /// Opt-in crash reporting consent (panics + render errors only; no analytics,
    /// no usage telemetry, ever). Off by default.
    pub crash_reporting: Option<bool>,
    /// Crash-reporting endpoint (Sentry / self-hosted GlitchTip). Empty disables
    /// sending even with consent on.
    pub crash_report_endpoint: Option<String>,
}

/// Read persisted prefs, or defaults when absent/unreadable.
///
/// The backend reads the same prefs file the frontend writes rather than having
/// settings passed in per call: there's then exactly one copy of the truth, and
/// no way for a command to be invoked with settings that disagree with what the
/// user last saved. `pub(crate)` so `run()` can apply the log level and crash
/// consent at boot (B73).
pub(crate) fn read_prefs(app: &tauri::AppHandle) -> Prefs {
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
///
/// The backend-visible fields are applied immediately (B73): the log level
/// reloads the tracing filter without a restart, and the crash-report consent +
/// endpoint arm or disarm the reporter. The rest is the frontend's business.
#[tauri::command]
pub fn save_prefs(app: tauri::AppHandle, prefs: Prefs) -> AppResult<()> {
    let path = prefs_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::write(path, text).map_err(|e| AppError::Other(e.to_string()))?;

    if let Some(level) = &prefs.log_level {
        if logging::is_valid_level(level) {
            logging::set_level(level);
        }
    }
    crash_reporting::set_config(
        prefs.crash_reporting.unwrap_or(false),
        prefs.crash_report_endpoint.unwrap_or_default(),
    );
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

/// Standalone kubeconfig YAML for one context (M9 QR handoff).
///
/// Same winner as the switcher: a name that exists in the default kubeconfig
/// is read from there, not from an imported file of the same name.
#[tauri::command]
pub async fn export_context_kubeconfig(
    context: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let manager: Arc<ClientManager> = (*mgr).clone();
    let in_default = client::list_contexts()
        .ok()
        .is_some_and(|cs| cs.iter().any(|c| c.name == context));
    let yaml = if in_default {
        let path = client::default_kubeconfig_path();
        if path.is_empty() {
            return Err(AppError::Kubeconfig("no default kubeconfig".into()));
        }
        std::fs::read_to_string(&path).map_err(|e| AppError::Kubeconfig(e.to_string()))?
    } else {
        let path = manager.import_path(&context).await.ok_or_else(|| {
            AppError::Kubeconfig(format!("context \"{context}\" is not imported"))
        })?;
        std::fs::read_to_string(&path).map_err(|e| AppError::Kubeconfig(e.to_string()))?
    };
    client::extract_context_yaml(&yaml, &context)
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
    let cid: Cid = context.clone();

    // Reuse a live connection (B76): the manager re-emits its retained snapshots
    // on `{event}:{cid}` and we hand back the cached info — the O(instant) switch.
    // Other clusters are never touched.
    if manager.is_connected(&cid).await {
        manager.refresh(&cid).await;
        return manager
            .info(&cid)
            .await
            .ok_or_else(|| AppError::Other("connection state missing".into()));
    }

    // Fresh connection for this cid only.
    // If this context was imported from a specific file, build the client from
    // that file; otherwise use the default kubeconfig resolution.
    let (kube_client, server) = match manager.import_path(&context).await {
        Some(path) => client::build_client_from_file(&path, &context).await?,
        None => client::build_client(&context).await?,
    };
    let version = client::probe_version(&kube_client).await?;

    // Start watchers for all kinds and register their tasks.
    let watcher_count =
        watchers::spawn_all(manager.clone(), cid.clone(), kube_client.clone()).await;

    // Start the metrics + status pollers and register them too.
    // Poll intervals come from the user's settings (B23). Read at connect, so a
    // change takes effect on the next connection rather than restarting live
    // pollers for a value measured in seconds.
    let (metrics_task, status_task) = metrics::spawn_pollers(
        manager.clone(),
        cid.clone(),
        kube_client.clone(),
        poll_intervals(&manager.app()),
    );
    manager.push_task(cid.clone(), metrics_task).await;
    manager.push_task(cid.clone(), status_task).await;

    // Discover CRD-backed kinds and tell the frontend about them (B15). Their
    // watchers start lazily when the user opens one, so this only populates the
    // nav — a cluster with dozens of CRDs costs nothing until a kind is opened.
    let custom = discovery::discover(&kube_client).await;
    manager.set_custom_kinds(cid.clone(), custom.clone()).await;
    manager.emit_kinds(&cid, custom).await;

    // Record the live connection (also emits the initial watch-status count).
    let info = ClusterInfo {
        context: context.clone(),
        cluster_name: context,
        server,
        version,
    };
    manager.set_connected(cid, kube_client, info.clone(), watcher_count).await;
    Ok(info)
}

/// Cluster-wide allocatable capacity for the Overview dashboard (B79). The
/// frontend derives pod requests (from pod rows) and usage (from cluster-status
/// percentages); this supplies the absolute allocatable that is only read here.
#[tauri::command]
pub async fn cluster_overview(cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<overview::ClusterOverview> {
    let client = require_client(&mgr, &cid).await?;
    overview::cluster_overview(client).await.map_err(|e| AppError::Kube(e.to_string()))
}

/// Tear down one cluster's connection: its watchers, pollers, streams and
/// forwards. Other connected clusters are untouched (B76).
#[tauri::command]
pub async fn disconnect(cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    mgr.disconnect(&cid).await;
    Ok(())
}

/// Map a frontend kind id to its `ApiResource` and whether it is namespaced. The
/// kind id doubles as the resource plural, so we build the ApiResource directly
/// (avoiding fragile plural-guessing).
///
/// A custom (CRD-backed) kind id contains a slash ("group/plural", B15) and is
/// resolved from the kinds discovered on connect, so YAML/delete/events work on
/// CRDs through the same path as built-ins.
async fn resource_for(kind: &str, cid: &Cid, mgr: &ClientManager) -> AppResult<(ApiResource, bool)> {
    if kind.contains('/') {
        return match mgr.custom_kind(cid, kind).await {
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
        "roles" => ("rbac.authorization.k8s.io", "v1", "Role", true),
        "clusterroles" => ("rbac.authorization.k8s.io", "v1", "ClusterRole", false),
        "rolebindings" => ("rbac.authorization.k8s.io", "v1", "RoleBinding", true),
        "clusterrolebindings" => ("rbac.authorization.k8s.io", "v1", "ClusterRoleBinding", false),
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
    cid: &Cid,
    mgr: &ClientManager,
) -> AppResult<Api<DynamicObject>> {
    let (ar, namespaced) = resource_for(kind, cid, mgr).await?;
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
pub async fn get_yaml(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr, &cid).await?;
    // A Helm release isn't an API object, so there's nothing to GET: its YAML is
    // the manifest the chart rendered, which is what you actually want to read
    // (B26). Secret values in it are already redacted by the decoder.
    if kind == ResourceKind::Helm.id() {
        return helm_manifest(client, &namespace, &name).await;
    }
    let api = dynamic_api(client, &kind, &namespace, &cid, &mgr).await?;
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

/// The live object and its last-applied baseline, for the Diff tab (B54).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    /// The live object as YAML (redacted for Secrets).
    pub live: String,
    /// The last-applied baseline as YAML, when one can be reconstructed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<String>,
}

/// The delta between an object and its last-applied configuration (B54).
///
/// The baseline is the `kubectl.kubernetes.io/last-applied-configuration`
/// annotation (client-side apply); when it's absent, a reconstruction from the
/// server-side-apply managed fields. Neither present → `baseline: None`, and the
/// UI shows a clean "no baseline" state.
#[tauri::command]
pub async fn get_diff(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<DiffPayload> {
    let client = require_client(&mgr, &cid).await?;
    let api = dynamic_api(client, &kind, &namespace, &cid, &mgr).await?;
    let mut obj = api.get(&name).await?;
    // Never surface Secret values — in the live YAML or the baseline (a Secret's
    // last-applied annotation carries the raw data). `redact_secret` touches the
    // data map, not the annotations, so the baseline is still extractable after.
    if kind == "secrets" {
        redact_secret(&mut obj);
    }
    let live = serde_yaml::to_string(&obj)?;
    let baseline = last_applied_baseline(&obj)
        .map(|v| if kind == "secrets" { redact_secret_value(v) } else { v })
        .map(|v| serde_yaml::to_string(&v).unwrap_or_default())
        .filter(|s| !s.is_empty());
    Ok(DiffPayload { live, baseline })
}

/// The last-applied configuration of an object, or None when there's no source:
/// the client-side-apply annotation first, then a managed-fields reconstruction.
fn last_applied_baseline(obj: &DynamicObject) -> Option<serde_json::Value> {
    if let Some(ann) = obj
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("kubectl.kubernetes.io/last-applied-configuration"))
    {
        if let Ok(v) = serde_yaml::from_str::<serde_json::Value>(ann) {
            return Some(v);
        }
    }
    // Server-side apply: the apply-manager's fieldsV1 gives the shape; the live
    // object's values are the only surviving copy of what was applied.
    let fields = obj
        .metadata
        .managed_fields
        .as_ref()?
        .iter()
        .find(|m| m.operation.as_deref() == Some("Apply"))
        .and_then(|m| m.fields_v1.clone())?;
    let full = serde_json::to_value(obj).ok()?;
    reconstruct_from_managed(&full, &fields.0)
}

/// Reconstruct an applied object from a fieldsV1 tree: keep the live values only
/// where the tree marks a field as applied. Objects recurse (owning their
/// sub-fields); leaves and atomic lists are taken wholesale.
fn reconstruct_from_managed(
    live: &serde_json::Value,
    fields: &serde_json::Value,
) -> Option<serde_json::Value> {
    let obj = fields.as_object()?;
    let mut out = serde_json::Map::new();
    for (key, marker) in obj {
        let Some(name) = key.strip_prefix("f:") else { continue };
        let Some(live_v) = live.get(name) else { continue };
        if marker.is_object() && live_v.is_object() {
            if let Some(recon) = reconstruct_from_managed(live_v, marker) {
                out.insert(name.to_string(), recon);
            }
        } else {
            out.insert(name.to_string(), live_v.clone());
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(serde_json::Value::Object(out))
}

/// Mask the values of a Secret's data/stringData maps, for a baseline YAML.
fn redact_secret_value(mut v: serde_json::Value) -> serde_json::Value {
    for field in ["data", "stringData"] {
        if let Some(serde_json::Value::Object(map)) = v.get_mut(field) {
            for val in map.values_mut() {
                *val = serde_json::Value::String("<redacted>".into());
            }
        }
    }
    v
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

/// The value of one Secret key, for the clipboard (B37). `data` values are
/// base64 and decode to text; a value that isn't UTF-8 (a TLS key, a
/// dockerconfig) stays in its base64 form — copying raw bytes to a text
/// clipboard is useless. `stringData` values are already plain.
fn secret_value(secret: &k8s_openapi::api::core::v1::Secret, key: &str) -> Option<String> {
    if let Some(bs) = secret.data.as_ref().and_then(|d| d.get(key)) {
        return Some(match String::from_utf8(bs.0.clone()) {
            Ok(text) => text,
            Err(_) => {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(&bs.0)
            }
        });
    }
    secret.string_data.as_ref().and_then(|s| s.get(key)).cloned()
}

/// Copy one Secret value to the system clipboard (B37). The value is decoded and
/// written entirely in Rust — it never crosses into the webview, so the UI only
/// ever learns that the copy succeeded, not what it copied.
#[tauri::command]
pub async fn copy_secret_value(cid: String, 
    namespace: String,
    name: String,
    key: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
    let api: Api<k8s_openapi::api::core::v1::Secret> = Api::namespaced(client, &namespace);
    let secret = api.get(&name).await?;
    let value = secret_value(&secret, &key)
        .ok_or_else(|| AppError::NotFound(format!("no key {key} in {namespace}/{name}")))?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(value)
        .map_err(|e| AppError::Other(format!("clipboard write failed: {e}")))?;
    Ok(())
}

/// Show a native notification that a problem appeared (B50). The target is
/// carried as `extra` payload, so a click can focus the window and navigate to
/// the object. Best-effort: the OS can quietly disable notifications, and that
/// isn't an app error — it's the user's choice.
#[tauri::command]
pub async fn notify_problem(
    kind: String,
    namespace: String,
    name: String,
    reason: String,
    app: tauri::AppHandle,
) -> AppResult<()> {
    use tauri_plugin_notification::NotificationExt;
    let result = app
        .notification()
        .builder()
        .title(format!("{kind}: {name}"))
        .body(reason)
        .extra("kind", kind.clone())
        .extra("namespace", namespace.clone())
        .extra("name", name.clone())
        .show();
    if let Err(e) = result {
        tracing::warn!("problem notification failed to show: {e}");
    }
    Ok(())
}

/// Apply edited YAML back to the cluster via replace (preserving resourceVersion
/// from the edited text). API errors are returned verbatim for inline display.
#[tauri::command]
pub async fn apply_yaml(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    yaml: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
    ensure_writable(&kind)?;
    let obj: DynamicObject = serde_yaml::from_str(&yaml)?;
    let api = dynamic_api(client, &kind, &namespace, &cid, &mgr).await?;
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
pub async fn dry_run_yaml(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    yaml: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<YamlDiff> {
    let client = require_client(&mgr, &cid).await?;
    ensure_writable(&kind)?;
    let obj: DynamicObject = serde_yaml::from_str(&yaml)?;
    let api = dynamic_api(client, &kind, &namespace, &cid, &mgr).await?;

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

/// The answer to a create-from-YAML request (B36): what the server would store,
/// and — when actually created — where it went.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOutcome {
    /// The manifest as the server would store it (dry-run result), for preview.
    pub proposed: String,
    /// The created object's nav target; present only when not a dry run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<CreatedTarget>,
}

/// Where a created object landed, for the frontend to navigate to it.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTarget {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub name: String,
}

/// Create an object from pasted YAML (B36). The manifest's apiVersion/kind
/// select the resource (built-in, or a discovered CRD by group+kind);
/// metadata.namespace — or the supplied namespace — places it. With
/// `dry_run`, nothing is written: the server returns the object as it would
/// store it (defaulting + admission applied), which is the preview.
#[tauri::command]
pub async fn create_resource(
    yaml: String,
    namespace: String,
    dry_run: bool,
    mgr: State<'_, Arc<ClientManager>>,
    cid: String,
) -> AppResult<CreateOutcome> {
    let client = require_client(&mgr, &cid).await?;
    let mut obj: DynamicObject = serde_yaml::from_str(&yaml)?;
    let kind = obj.types.as_ref().map(|t| t.kind.clone()).unwrap_or_default();
    let api_version = obj.types.as_ref().map(|t| t.api_version.clone()).unwrap_or_default();
    if kind.is_empty() || api_version.is_empty() {
        return Err(AppError::Other("the manifest needs apiVersion and kind".into()));
    }
    let nav = nav_for_manifest(&mgr, &cid, &kind, &api_version).await
        .ok_or_else(|| AppError::Other(format!("cannot create a {kind}: it isn't a listed kind")))?;
    let (ar, namespaced) = resource_for(&nav, &cid, &mgr).await?;
    // The object's own namespace wins; else the supplied one. Cluster-scoped
    // kinds ignore both.
    let ns = if namespaced { obj.metadata.namespace.clone().unwrap_or(namespace) } else { String::new() };
    if namespaced {
        obj.metadata.namespace = Some(ns.clone());
    }
    let api: Api<DynamicObject> = if namespaced {
        Api::namespaced_with(client, &ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let pp = if dry_run {
        PostParams { dry_run: true, ..Default::default() }
    } else {
        PostParams::default()
    };
    let mut created = api.create(&pp, &obj).await?;
    created.metadata.managed_fields = None;
    let name = created.metadata.name.clone().unwrap_or_default();
    Ok(CreateOutcome {
        proposed: serde_yaml::to_string(&created)?,
        created: (!dry_run).then(|| CreatedTarget {
            kind: nav,
            namespace: namespaced.then_some(ns),
            name,
        }),
    })
}

/// Resolve a parsed manifest's Kind + apiVersion to a nav id: a built-in by its
/// Kind, a CRD by Kind+group against the discovered kinds.
async fn nav_for_manifest(mgr: &ClientManager, cid: &Cid, kind: &str, api_version: &str) -> Option<String> {
    if let Some(nav) = properties::builtin_nav_id(kind) {
        return Some(nav.to_string());
    }
    let group = api_version.split('/').next().unwrap_or_default();
    mgr.custom_kind_by_name(cid, group, kind).await.map(|k| k.id)
}

/// Delete a resource of any kind. The frontend confirms first; API errors are
/// returned verbatim.
#[tauri::command]
pub async fn delete_resource(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
    let api = dynamic_api(client, &kind, &namespace, &cid, &mgr).await?;
    api.delete(&name, &DeleteParams::default()).await?;
    Ok(())
}

/// Scale a Deployment/StatefulSet by patching `spec.replicas`.
#[tauri::command]
pub async fn scale_resource(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    replicas: i32,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
    let api = dynamic_api(client, &kind, &namespace, &cid, &mgr).await?;
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
    cid: String,
) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
    let api = dynamic_api(client, "nodes", "", &cid, &mgr).await?;
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
pub async fn restart_pod(cid: String, 
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
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
pub async fn restart_rollout(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    if !restart::is_rollout_kind(&kind) {
        return Err(AppError::Other(format!("{kind} cannot be rollout-restarted")));
    }
    let client = require_client(&mgr, &cid).await?;
    let api = dynamic_api(client, &kind, &namespace, &cid, &mgr).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let patch = Patch::Merge(restart::restart_patch(&now));
    api.patch(&name, &PatchParams::default(), &patch).await?;
    Ok(())
}

/// Undo a Deployment rollout (B34b): copy the ReplicaSet at `revision`'s pod
/// template back onto the Deployment, so the controller rolls to that revision's
/// pods again. The safety net restart (B34) never had.
///
/// The target ReplicaSet is found the same way the properties panel lists them —
/// owned by uid, resolved by the `deployment.kubernetes.io/revision` annotation —
/// and the copy is a single merge patch on `spec.template`.
#[tauri::command]
pub async fn undo_rollout(cid: String, 
    namespace: String,
    name: String,
    revision: i64,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<i64> {
    let client = require_client(&mgr, &cid).await?;
    let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
    let dep = api.get(&name).await?;
    let uid = dep.metadata.uid.as_deref().unwrap_or_default();
    let owned = properties::owned_replicasets(&client, &namespace, uid).await;
    let patch = restart::undo_patch_for_revision(&owned, revision).ok_or_else(|| {
        AppError::Other(format!("no ReplicaSet at revision {revision} for {namespace}/{name}"))
    })?;
    api.patch(&name, &PatchParams::default(), &Patch::Merge(patch)).await?;
    Ok(revision)
}

/// Suspend or resume a CronJob by patching `spec.suspend` (B47).
#[tauri::command]
pub async fn set_cronjob_suspend(cid: String, 
    namespace: String,
    name: String,
    suspended: bool,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
    let api: Api<CronJob> = Api::namespaced(client, &namespace);
    api.patch(&name, &PatchParams::default(), &Patch::Merge(batch::suspend_patch(suspended)))
        .await?;
    Ok(())
}

/// Run a CronJob's jobTemplate now (B47): create a Job from it, the exact
/// mechanic of `kubectl create job --from=cronjob/x`. The Job is owned by
/// nothing, so it can be deleted on its own. Returns the new Job's name.
#[tauri::command]
pub async fn run_cronjob(cid: String, 
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr, &cid).await?;
    let api: Api<CronJob> = Api::namespaced(client.clone(), &namespace);
    let cronjob = api.get(&name).await?;
    let seq = STREAM_SEQ.fetch_add(1, Ordering::Relaxed);
    let job = batch::manual_job(&cronjob, seq)
        .ok_or_else(|| AppError::Other(format!("{namespace}/{name} has no jobTemplate")))?;
    let jobs: Api<Job> = Api::namespaced(client, &namespace);
    let created = jobs.create(&PostParams::default(), &job).await?;
    Ok(created.metadata.name.unwrap_or_default())
}

/// Retry a failed Job (B47): delete it, then recreate from its own spec minus
/// the controller-owned fields, so the retry is a fresh, unowned Job. Refuses a
/// Job that hasn't failed. Returns the new Job's name.
#[tauri::command]
pub async fn retry_job(cid: String, 
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<String> {
    let client = require_client(&mgr, &cid).await?;
    let jobs: Api<Job> = Api::namespaced(client.clone(), &namespace);
    let job = jobs.get(&name).await?;
    let failed = job
        .status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| cs.iter().any(|c| c.type_ == "Failed" && c.status == "True"))
        .unwrap_or(false);
    if !failed {
        return Err(AppError::Other(format!("{namespace}/{name} hasn't failed; nothing to retry")));
    }
    let seq = STREAM_SEQ.fetch_add(1, Ordering::Relaxed);
    let retried = batch::retried_job(&job, seq).ok_or_else(|| AppError::Other("Job has no spec".into()))?;
    jobs.delete(&name, &DeleteParams::default()).await?;
    let created = jobs.create(&PostParams::default(), &retried).await?;
    Ok(created.metadata.name.unwrap_or_default())
}

/// Start watching a custom (CRD-backed) kind (B15), if it isn't already watched.
///
/// Called when the user opens a custom kind. Watching is lazy and reference-free:
/// a cluster can define hundreds of CRDs, and watching them all on connect would
/// open a stream per CRD for data nobody is looking at.
#[tauri::command]
pub async fn watch_custom_kind(kind: String, cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    let manager: Arc<ClientManager> = (*mgr).clone();
    // Already open — nothing to do (navigating back to a kind is common).
    if manager.has_custom_watcher(&cid, &kind).await {
        return Ok(());
    }
    let client = require_client(&mgr, &cid).await?;
    let ck = manager
        .custom_kind(&cid, &kind)
        .await
        .ok_or_else(|| AppError::Other(format!("unknown custom kind: {kind}")))?;
    watchers::spawn_custom(&manager, &cid, client, &ck).await;
    Ok(())
}

/// Stop watching a custom kind (B15). Idempotent: unknown ids are a no-op, so the
/// frontend can call this unconditionally when navigating away.
#[tauri::command]
pub async fn unwatch_custom_kind(kind: String, cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    mgr.remove_custom_watcher(&cid, &kind).await;
    Ok(())
}

/// Drain a node (B20): cordon it, then evict its pods in the background.
///
/// Cordoning happens inline so an RBAC/not-found failure surfaces as a rejected
/// command rather than a silent no-op. The eviction pass then runs as a
/// connection-scoped task reporting via [`kube::events::DRAIN_PROGRESS`] — it can
/// take minutes, so blocking the command on it would freeze the UI.
#[tauri::command]
pub async fn drain_node(name: String, cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    let client = require_client(&mgr, &cid).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Cordon first: without it the scheduler could refill the node as we drain it.
    drain::cordon(client.clone(), &name).await?;

    let app = manager.app();
    let cid_task = cid.clone();
    let task = tokio::spawn(async move {
        drain::run_drain(client, app, cid_task, name).await;
    });
    manager.push_task(cid, task).await;
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
    cid: String,
) -> AppResult<Vec<exporter::NodeSample>> {
    let client = require_client(&mgr, &cid).await?;
    let Some(svc) = promql::discover(&client).await else {
        return Ok(Vec::new());
    };
    let now = chrono::Utc::now().timestamp();
    // An hour at 30s is 120 points — enough to open with a populated chart
    // without crowding out the live samples that follow (the series is capped).
    promql::node_history(&client, &svc, &node, now, 3600, 30).await
}

/// Backfill a pod's CPU/MEM history for the detail-header sparklines (B44),
/// or empty when the cluster has no Prometheus we recognise.
///
/// Empty is a normal answer, not an error: a cluster without Prometheus renders
/// the panel exactly as before, and nothing surfaces as a failure. Two range
/// queries max — one per sparkline — fired when the pod is opened.
#[tauri::command]
pub async fn pod_history(
    namespace: String,
    pod: String,
    mgr: State<'_, Arc<ClientManager>>,
    cid: String,
) -> AppResult<Vec<promql::PodPoint>> {
    let client = require_client(&mgr, &cid).await?;
    let Some(svc) = promql::discover(&client).await else {
        return Ok(Vec::new());
    };
    let now = chrono::Utc::now().timestamp();
    // Half an hour at 30s is 60 points — a compact sparkline's worth, cheaper
    // than the node charts' hour since it sits in the always-open header.
    promql::pod_history(&client, &svc, &namespace, &pod, now, 1800, 30).await
}

/// Start scraping a node's node-exporter for plots (B27), if not already running.
///
/// Called when a node's Metrics tab opens. Lazy for the same reason CRD watchers
/// are: each scrape moves a few hundred KB and holds a port-forward, which is not
/// something to run for every node in the background.
#[tauri::command]
pub async fn watch_node_stats(node: String, cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    let manager: Arc<ClientManager> = (*mgr).clone();
    if manager.has_node_scraper(&cid, &node).await {
        return Ok(());
    }
    let client = require_client(&mgr, &cid).await?;
    let app = manager.app();
    // Reuses the metrics poll interval from settings (B23): it's the same question
    // ("how often should we ask the cluster how it's doing"), so it would be odd
    // for the plots to march to a different drum than the table's CPU column.
    let every = poll_intervals(&app).metrics;
    let n = node.clone();
    let cid_task = cid.clone();
    let task = tokio::spawn(async move {
        nodestats::run_node_stats(client, app, cid_task, n, every).await;
    });
    manager.add_node_scraper(cid, node, task).await;
    Ok(())
}

/// Stop scraping a node (B27). Idempotent, so the frontend can call it
/// unconditionally when the tab closes; drops the port-forward with it.
#[tauri::command]
pub async fn unwatch_node_stats(node: String, cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<()> {
    mgr.remove_node_scraper(&cid, &node).await;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    involved: Option<EventInvolved>,
}

/// Gather an object's properties as a generic section document (B13, B18).
/// Errors for kinds with no gatherer — the frontend only offers the tab for the
/// kinds that have one.
#[tauri::command]
pub async fn get_properties(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<properties::Properties> {
    let client = require_client(&mgr, &cid).await?;
    properties::gather(client, &kind, &namespace, &name).await
}

/// The ownership/reference graph around a resource (B55).
#[tauri::command]
pub async fn get_topology(
    kind: String,
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
    cid: String,
) -> AppResult<topology::Topology> {
    let client = require_client(&mgr, &cid).await?;
    let api = dynamic_api(client.clone(), &kind, &namespace, &cid, &mgr).await?;
    let seed = api.get(&name).await?;
    let seed_kind = seed.types.as_ref().map(|t| t.kind.clone()).unwrap_or_default();
    topology::build(&client, &namespace, &seed_kind, &seed).await
}

/// List events for an object, newest first, field-selected by involvedObject.
#[tauri::command]
pub async fn get_events(
    namespace: String,
    name: String,
    mgr: State<'_, Arc<ClientManager>>,
    cid: String,
) -> AppResult<Vec<EventItem>> {
    let client = require_client(&mgr, &cid).await?;
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
            timestamp: e.first_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
            involved: Some(EventInvolved {
                kind: e.involved_object.kind.clone().unwrap_or_default(),
                name: e.involved_object.name.clone().unwrap_or_default(),
                namespace: e.involved_object.namespace.clone(),
                api_version: e.involved_object.api_version.clone(),
            }),
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
    cid: String,
) -> AppResult<String> {
    let client = require_client(&mgr, &cid).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Unique id per stream (pod name + sequence).
    let stream_id = format!("{}-{}", pod, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let app = manager.app();

    let opts = logs::LogStreamOptions { tail, since_time, since_seconds, previous };
    let id_for_task = stream_id.clone();
    let cid_task = cid.clone();
    let handle = tokio::spawn(async move {
        logs::run_log_stream(client, app, cid_task, id_for_task, namespace, pod, container, opts).await;
    });
    manager.add_log(cid, stream_id.clone(), handle).await;
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
pub async fn export_logs(cid: String, 
    namespace: String,
    pod: String,
    container: String,
    since_seconds: Option<i64>,
    previous: bool,
    path: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<usize> {
    let client = require_client(&mgr, &cid).await?;
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

/// Start following every pod of a workload (Deployment/StatefulSet/DaemonSet),
/// multiplexed into one stream id (B31). Resolves the workload's selector and
/// re-resolves the pod set on a slow tick, so scale-ups join and gone pods drop;
/// the bundle registers as a single manager entry, so one abort tears it all down.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_workload_logs(
    kind: String,
    namespace: String,
    name: String,
    tail: Option<i64>,
    since_time: Option<String>,
    since_seconds: Option<i64>,
    mgr: State<'_, Arc<ClientManager>>,
    cid: String,
) -> AppResult<String> {
    let client = require_client(&mgr, &cid).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // A distinct id namespace ("wl-") so a workload bundle can't collide with a
    // pod stream that happens to share the name.
    let stream_id = format!("wl-{}-{}", name, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let app = manager.app();
    let opts = logs::LogStreamOptions { tail, since_time, since_seconds, previous: false };
    let id_for_task = stream_id.clone();
    let cid_task = cid.clone();
    let handle = tokio::spawn(async move {
        logs::run_workload_log_stream(client, app, cid_task, id_for_task, kind, namespace, name, opts).await;
    });
    manager.add_log(cid, stream_id.clone(), handle).await;
    Ok(stream_id)
}

/// Write the full logs of every pod a workload selects to `path` (B31), labelled
/// by pod and container — the save path for a workload stream.
#[tauri::command]
pub async fn export_workload_logs(cid: String, 
    kind: String,
    namespace: String,
    name: String,
    since_seconds: Option<i64>,
    path: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<usize> {
    let client = require_client(&mgr, &cid).await?;
    let text = logs::export_workload_text(client, &kind, &namespace, &name, since_seconds).await?;
    let lines = text.lines().count();
    std::fs::write(&path, text).map_err(|e| AppError::Other(format!("could not write {path}: {e}")))?;
    Ok(lines)
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
    cid: String,
) -> AppResult<String> {
    let client = require_client(&mgr, &cid).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    let id = format!("sh-{}-{}", pod, STREAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>(8);
    let app = manager.app();
    // Read per-session, so changing the override applies to the next shell you
    // open rather than needing a reconnect (B23).
    let shell_override = read_prefs(&app).shell_command.unwrap_or_default();
    let id_for_task = id.clone();
    let cid_task = cid.clone();
    let task = tokio::spawn(async move {
        exec::run_shell(
            client,
            app,
            cid_task,
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
        .add_shell(cid, id.clone(), ShellSession { task, input_tx, resize_tx })
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
    cid: String,
) -> AppResult<NodeShellInfo> {
    let client = require_client(&mgr, &cid).await?;
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
    let cid_task = cid.clone();
    let task = tokio::spawn(async move {
        exec::run_argv(
            client,
            app,
            cid_task,
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
    manager.add_shell(cid, id.clone(), ShellSession { task, input_tx, resize_tx }).await;
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
pub async fn stop_node_shell(cid: String, 
    stream_id: String,
    pod: String,
    mgr: State<'_, Arc<ClientManager>>,
) -> AppResult<()> {
    mgr.remove_shell(&stream_id).await;
    if let Some(client) = mgr.client(&cid).await {
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
    cid: String,
) -> AppResult<ForwardDto> {
    let client = require_client(&mgr, &cid).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    // Fail fast with a clear message if the pod is gone.
    portforward::ensure_pod(client.clone(), &namespace, &pod).await?;

    spawn_forward(manager, client, cid, namespace, pod, None, remote_port).await
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
    cid: String,
) -> AppResult<ForwardDto> {
    let client = require_client(&mgr, &cid).await?;
    let manager: Arc<ClientManager> = (*mgr).clone();

    let (pod, target_port) =
        portforward::resolve_service(client.clone(), &namespace, &service, remote_port).await?;

    spawn_forward(manager, client, cid, namespace, pod, Some((service, remote_port)), target_port).await
}

/// Bind a local listener, spawn the forward's accept loop, and register it.
/// Shared by the pod and Service paths — by this point a Service forward *is* a
/// pod forward.
#[allow(clippy::too_many_arguments)]
async fn spawn_forward(
    manager: Arc<ClientManager>,
    client: kube::Client,
    cid: Cid,
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
        cid: cid.clone(),
        namespace,
        pod,
        service: service_name,
        remote_port,
        service_port,
        local_port,
        error: None,
    };
    manager.add_forward(cid.clone(), dto.clone(), task).await;

    // Relay per-connection failures onto the forward for the UI. Ends on its own
    // when the forward task is aborted and drops the sender.
    let relay_mgr = manager.clone();
    let relay = tokio::spawn(async move {
        while let Some(e) = err_rx.recv().await {
            relay_mgr.set_forward_error(&id, e).await;
        }
    });
    manager.push_task(cid.clone(), relay).await;

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
pub async fn list_port_forwards(cid: String, mgr: State<'_, Arc<ClientManager>>) -> AppResult<Vec<ForwardDto>> {
    Ok(mgr.list_forwards(&cid).await)
}

/// Forward a frontend (React/window) error to the backend log and, when armed,
/// to crash reporting (B73). Never fails — the UI must not depend on it.
#[tauri::command]
pub fn log_frontend_error(source: String, message: String, stack: Option<String>) {
    let detail = format!("[{source}] {message}\n{}", stack.as_deref().unwrap_or(""));
    tracing::error!(target: "frontend", "frontend {source}: {detail}");
    crash_reporting::frontend_error(&source, &message, stack.as_deref());
}

/// Export the diagnostics bundle (B73): the log tail + versions + redacted
/// settings + the last boundary trace, zipped to `path`. `context`/`cluster`
/// come from the frontend's connection state.
#[tauri::command]
pub fn export_diagnostics(
    app: tauri::AppHandle,
    path: String,
    context: Option<String>,
    cluster: Option<String>,
    boundary_trace: Option<String>,
) -> AppResult<()> {
    diagnostics::export(
        &app,
        std::path::Path::new(&path),
        context.as_deref(),
        cluster.as_deref(),
        boundary_trace.as_deref(),
    )
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/// Get the active client or a friendly "not connected" error.
async fn require_client(mgr: &ClientManager, cid: &Cid) -> AppResult<kube::Client> {
    mgr.client(cid)
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

#[cfg(test)]
mod tests {
    use super::secret_value;
    use k8s_openapi::api::core::v1::Secret;
    use serde_json::json;

    /// A text value in `data` (base64) decodes to its plaintext — the thing
    /// `kubectl get secret … | base64 -d` yields.
    #[test]
    fn data_text_value_decodes() {
        let s: Secret = serde_json::from_value(json!({
            "metadata": { "name": "creds", "namespace": "prod" },
            "data": { "password": "aHVudGVyMg==" }, // "hunter2"
        }))
        .unwrap();
        assert_eq!(secret_value(&s, "password").as_deref(), Some("hunter2"));
    }

    /// A binary value (a TLS key) stays in its base64 form — copying raw bytes to
    /// a text clipboard would be useless.
    #[test]
    fn binary_value_stays_base64() {
        let s: Secret = serde_json::from_value(json!({
            "metadata": { "name": "tls", "namespace": "prod" },
            "data": { "tls.key": "AP////8=" }, // 0x00ff ffff, not UTF-8 text
        }))
        .unwrap();
        assert_eq!(secret_value(&s, "tls.key").as_deref(), Some("AP////8="));
    }

    /// `stringData` values are already plain; an unknown key is None.
    #[test]
    fn string_data_is_plain_and_missing_key_is_none() {
        let s: Secret = serde_json::from_value(json!({
            "metadata": { "name": "creds", "namespace": "prod" },
            "stringData": { "username": "admin" },
        }))
        .unwrap();
        assert_eq!(secret_value(&s, "username").as_deref(), Some("admin"));
        assert_eq!(secret_value(&s, "nope"), None);
    }
}

#[cfg(test)]
mod diff_tests {
    use super::*;
    use kube::core::DynamicObject;
    use serde_json::json;

    /// The client-side-apply annotation is the baseline, verbatim.
    #[test]
    fn baseline_from_last_applied_annotation() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {
                "name": "api", "namespace": "prod",
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration":
                        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 2\n"
                },
            },
            "spec": { "replicas": 3 },
        }))
        .unwrap();
        let baseline = last_applied_baseline(&obj).expect("the annotation is the baseline");
        assert_eq!(baseline["spec"]["replicas"], 2, "the applied value, not the live one");
    }

    /// No annotation: a server-side-apply object reconstructs its applied shape
    /// from the apply-manager's fieldsV1, taking values from the live object.
    #[test]
    fn baseline_reconstructed_from_managed_fields() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {
                "name": "api",
                "labels": { "app": "api" },
                "managedFields": [{
                    "manager": "kubectl-client-side-apply",
                    "operation": "Apply",
                    "fieldsType": "FieldsV1",
                    "fieldsV1": {
                        "f:metadata": { "f:labels": { "f:app": {} } },
                        "f:spec": { "f:replicas": {} },
                    },
                }],
            },
            "spec": { "replicas": 5, "selector": { "matchLabels": { "app": "api" } } },
        }))
        .unwrap();
        let baseline = last_applied_baseline(&obj).expect("managed fields reconstruct a baseline");
        assert_eq!(baseline["spec"]["replicas"], 5, "an applied field keeps its live value");
        assert_eq!(baseline["metadata"]["labels"]["app"], "api");
        // serde_json's index returns Null for a missing key, so this covers
        // both "absent" and "explicitly null": either way it wasn't applied.
        assert!(baseline["spec"]["selector"].is_null(),
            "an unapplied field (selector) is not part of the baseline");
    }

    /// Neither annotation nor apply-managed-fields: no baseline.
    #[test]
    fn no_baseline_without_annotation_or_apply_fields() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": "c", "namespace": "prod" },
            "data": { "k": "v" },
        }))
        .unwrap();
        assert!(last_applied_baseline(&obj).is_none());
    }
}
