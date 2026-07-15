//! Kubeconfig parsing and client construction.
//!
//! `list_contexts` enumerates kubeconfig contexts for the cluster switcher, and
//! `build_client` / `probe_cluster` construct a client for a chosen context and
//! read its server version. No watchers are started here — that is the manager's
//! job (see manager.rs) after a successful connect.

use crate::error::{AppError, AppResult};
use kube::config::{Config, KubeConfigOptions, Kubeconfig};
use kube::Client;
use serde::Serialize;

/// A kubeconfig context entry for the cluster switcher.
#[derive(Serialize, Clone, Debug)]
pub struct ContextInfo {
    pub name: String,
    /// Cluster this context points at (shown as the right-hand env tag).
    pub cluster: String,
    /// True for the kubeconfig's current-context.
    pub current: bool,
}

/// Result of a successful connect.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub context: String,
    pub cluster_name: String,
    /// API server URL.
    pub server: String,
    /// Server git version (e.g. "v1.31.2").
    pub version: String,
}

/// Read the kubeconfig and list its contexts, flagging the current one.
///
/// Returns an empty list (not an error) when no kubeconfig exists, so the UI can
/// show a clean "disconnected" state rather than crashing.
pub fn list_contexts() -> AppResult<Vec<ContextInfo>> {
    let kubeconfig = match Kubeconfig::read() {
        Ok(kc) => kc,
        // Missing/unreadable kubeconfig is a normal state, not a hard error.
        Err(e) => {
            tracing::warn!("could not read kubeconfig: {e}");
            return Ok(Vec::new());
        }
    };

    let current = kubeconfig.current_context.clone().unwrap_or_default();
    let contexts = kubeconfig
        .contexts
        .iter()
        .map(|ctx| {
            // A NamedContext's inner Context carries the cluster name.
            let cluster = ctx
                .context
                .as_ref()
                .map(|c| c.cluster.clone())
                .unwrap_or_default();
            ContextInfo {
                name: ctx.name.clone(),
                cluster,
                current: ctx.name == current,
            }
        })
        .collect();

    Ok(contexts)
}

/// Read a kubeconfig file at an arbitrary path and list its contexts.
///
/// Used by the "Import kubeconfig" action. Contexts are reported with
/// `current: false` — the notion of a "current" context belongs to the default
/// kubeconfig, not to an imported file.
pub fn contexts_from_file(path: &str) -> AppResult<Vec<ContextInfo>> {
    let kubeconfig = Kubeconfig::read_from(path)?;
    let contexts = kubeconfig
        .contexts
        .iter()
        .map(|ctx| {
            let cluster = ctx
                .context
                .as_ref()
                .map(|c| c.cluster.clone())
                .unwrap_or_default();
            ContextInfo { name: ctx.name.clone(), cluster, current: false }
        })
        .collect();
    Ok(contexts)
}

/// Build a client for a context defined in a specific kubeconfig file (an imported
/// file that is not the default kubeconfig).
pub async fn build_client_from_file(path: &str, context: &str) -> AppResult<(Client, String)> {
    let kubeconfig = Kubeconfig::read_from(path)?;
    let options = KubeConfigOptions {
        context: Some(context.to_string()),
        cluster: None,
        user: None,
    };
    let config = Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|e| AppError::Kubeconfig(e.to_string()))?;
    let server = config.cluster_url.to_string();
    let client = Client::try_from(config)?;
    Ok((client, server))
}

/// Best-effort path to kubectl's default kubeconfig: the first entry of
/// $KUBECONFIG, else ~/.kube/config. Used to pre-point the import file dialog.
pub fn default_kubeconfig_path() -> String {
    if let Ok(kubeconfig) = std::env::var("KUBECONFIG") {
        if let Some(first) = kubeconfig.split(':').find(|s| !s.is_empty()) {
            return first.to_string();
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return format!("{home}/.kube/config");
    }
    String::new()
}

/// Build a Kubernetes client for a specific kubeconfig context.
pub async fn build_client(context: &str) -> AppResult<(Client, String)> {
    // Select the requested context explicitly (don't rely on current-context).
    let options = KubeConfigOptions {
        context: Some(context.to_string()),
        cluster: None,
        user: None,
    };
    let config = Config::from_kubeconfig(&options)
        .await
        .map_err(|e| AppError::Kubeconfig(e.to_string()))?;

    let server = config.cluster_url.to_string();
    let client = Client::try_from(config)?;
    Ok((client, server))
}

/// Probe the API server for its version. Also serves as a reachability check.
pub async fn probe_version(client: &Client) -> AppResult<String> {
    let info = client.apiserver_version().await?;
    Ok(info.git_version)
}
