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

/// The separator `$KUBECONFIG` uses between paths: `;` on Windows, where `:`
/// would also split the drive letter off `C:\Users\…`, `:` elsewhere. Split out
/// from [`first_kubeconfig_entry`] so the platform behaviour is unit-testable on
/// the CI matrix, not just macOS (B71).
fn kubeconfig_separator() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

/// First non-empty entry of a `$KUBECONFIG` path list, or None when it's empty.
fn first_kubeconfig_entry(kubeconfig: &str) -> Option<&str> {
    kubeconfig.split(kubeconfig_separator()).find(|s| !s.is_empty())
}

/// Best-effort path to kubectl's default kubeconfig: the first entry of
/// $KUBECONFIG, else ~/.kube/config. Used to pre-point the import file dialog.
///
/// Both halves are platform-sensitive, and getting either wrong lands the dialog
/// in the wrong directory rather than failing loudly. `KUBECONFIG` is a path
/// *list* using the platform's separator — `;` on Windows (see
/// [`kubeconfig_separator`]). And Windows has no `HOME`; kubectl itself reads
/// `USERPROFILE` there.
pub fn default_kubeconfig_path() -> String {
    if let Ok(kubeconfig) = std::env::var("KUBECONFIG") {
        if let Some(first) = first_kubeconfig_entry(&kubeconfig) {
            return first.to_string();
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if home.is_empty() {
        return String::new();
    }
    // Join through PathBuf so the result uses the platform's own separator.
    std::path::Path::new(&home)
        .join(".kube")
        .join("config")
        .to_string_lossy()
        .into_owned()
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

/// A standalone kubeconfig containing only `context` and the cluster/user it
/// names. Used to render the M9 QR sequence — the phone must receive a complete
/// file, not a slice of a multi-context config.
pub fn extract_context_yaml(src: &str, context: &str) -> AppResult<String> {
    let v: serde_yaml::Value = serde_yaml::from_str(src)?;
    let contexts = v.get("contexts").and_then(|c| c.as_sequence()).ok_or_else(|| {
        AppError::Kubeconfig("kubeconfig has no contexts".into())
    })?;
    let ctx = contexts
        .iter()
        .find(|c| c.get("name").and_then(|n| n.as_str()) == Some(context))
        .ok_or_else(|| AppError::Kubeconfig(format!("context \"{context}\" not found")))?;
    let inner = ctx.get("context").cloned().unwrap_or(serde_yaml::Value::Null);
    let cluster = inner.get("cluster").and_then(|c| c.as_str()).unwrap_or("");
    let user = inner.get("user").and_then(|u| u.as_str()).unwrap_or("");

    let clusters = filter_named(v.get("clusters"), cluster);
    let users = filter_named(v.get("users"), user);

    let out = serde_yaml::Mapping::from_iter([
        (
            serde_yaml::Value::String("apiVersion".into()),
            v.get("apiVersion").cloned().unwrap_or(serde_yaml::Value::String("v1".into())),
        ),
        (
            serde_yaml::Value::String("kind".into()),
            v.get("kind").cloned().unwrap_or(serde_yaml::Value::String("Config".into())),
        ),
        (
            serde_yaml::Value::String("current-context".into()),
            serde_yaml::Value::String(context.into()),
        ),
        (serde_yaml::Value::String("clusters".into()), serde_yaml::Value::Sequence(clusters)),
        (
            serde_yaml::Value::String("contexts".into()),
            serde_yaml::Value::Sequence(vec![ctx.clone()]),
        ),
        (serde_yaml::Value::String("users".into()), serde_yaml::Value::Sequence(users)),
    ]);
    Ok(serde_yaml::to_string(&serde_yaml::Value::Mapping(out))?)
}

fn filter_named(list: Option<&serde_yaml::Value>, name: &str) -> Vec<serde_yaml::Value> {
    list.and_then(|v| v.as_sequence())
        .into_iter()
        .flatten()
        .filter(|item| item.get("name").and_then(|n| n.as_str()) == Some(name))
        .cloned()
        .collect()
}

/// Probe the API server for its version. Also serves as a reachability check.
pub async fn probe_version(client: &Client) -> AppResult<String> {
    let info = client.apiserver_version().await?;
    Ok(info.git_version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write `body` to a uniquely-named temp file and return its path.
    fn temp_file(tag: &str, body: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "k7s-test-{tag}-{}-{:?}.yaml",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        path
    }

    const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
current-context: alpha
clusters:
  - name: alpha-cluster
    cluster: { server: https://alpha.example:6443 }
  - name: beta-cluster
    cluster: { server: https://beta.example:6443 }
contexts:
  - name: alpha
    context: { cluster: alpha-cluster, user: alpha-user }
  - name: beta
    context: { cluster: beta-cluster, user: beta-user }
users:
  - name: alpha-user
    user: {}
  - name: beta-user
    user: {}
"#;

    /// An imported file contributes each of its contexts, tagged with its cluster.
    #[test]
    fn reads_contexts_from_a_kubeconfig_file() {
        let path = temp_file("ok", KUBECONFIG);
        let contexts = contexts_from_file(path.to_str().unwrap()).unwrap();
        let names: Vec<&str> = contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"]);
        assert_eq!(contexts[0].cluster, "alpha-cluster");
        // current-context belongs to the *default* kubeconfig; an imported file
        // never claims to be current (the merge in commands.rs relies on this).
        assert!(contexts.iter().all(|c| !c.current));
        std::fs::remove_file(path).ok();
    }

    /// A file that has been deleted since it was imported errors rather than
    /// panicking — restore_imports (B17) turns this into a silent drop on boot.
    #[test]
    fn missing_file_is_an_error() {
        let path = std::env::temp_dir().join("k7s-test-definitely-absent.yaml");
        assert!(contexts_from_file(path.to_str().unwrap()).is_err());
    }

    /// So does a file that is no longer a kubeconfig.
    #[test]
    fn unparseable_file_is_an_error() {
        let path = temp_file("junk", "this is not a kubeconfig at all\n\t- [");
        assert!(contexts_from_file(path.to_str().unwrap()).is_err());
        std::fs::remove_file(path).ok();
    }

    /// extract_context_yaml keeps only the named context and its cluster/user,
    /// including client-cert data — the QR payload the phone must receive whole.
    #[test]
    fn extracts_one_context_with_its_certs() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: beta
clusters:
  - name: alpha-cluster
    cluster: { server: https://alpha.example:6443, certificate-authority-data: AAA }
  - name: beta-cluster
    cluster: { server: https://beta.example:6443, certificate-authority-data: BBB }
contexts:
  - name: alpha
    context: { cluster: alpha-cluster, user: alpha-user }
  - name: beta
    context: { cluster: beta-cluster, user: beta-user }
users:
  - name: alpha-user
    user: { client-certificate-data: CERTA, client-key-data: KEYA }
  - name: beta-user
    user: { client-certificate-data: CERTB, client-key-data: KEYB }
"#;
        let out = extract_context_yaml(yaml, "beta").unwrap();
        assert!(out.contains("current-context: beta"));
        assert!(out.contains("beta-cluster"));
        assert!(out.contains("CERTB"));
        assert!(out.contains("KEYB"));
        assert!(!out.contains("alpha-cluster"));
        assert!(!out.contains("CERTA"));
    }

    #[test]
    fn extract_unknown_context_is_an_error() {
        assert!(extract_context_yaml(KUBECONFIG, "nope").is_err());
    }

    // ---- platform-conditional paths (B71): these run on the CI matrix ------

    /// The first non-empty entry of a $KUBECONFIG list wins, whatever the
    /// platform separator. The expected split is written against the same
    /// `cfg!(windows)` the code uses, so each platform's test asserts its own
    /// rule — on Windows the list is `;`-separated, elsewhere `:`.
    #[test]
    fn kubeconfig_first_entry_uses_the_platform_separator() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        // The separator between entries is the platform's own, so the second
        // path is a different entry and the first wins.
        let list = format!("/home/me/.kube/config{sep}/tmp/other");
        assert_eq!(first_kubeconfig_entry(&list), Some("/home/me/.kube/config"));
    }

    /// A leading empty entry (an env var starting with the separator) is
    /// skipped, matching what kubectl itself does.
    #[test]
    fn kubeconfig_first_entry_skips_empty_entries() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(
            first_kubeconfig_entry(&format!("{sep}{sep}/etc/empty{sep}/real")),
            Some("/etc/empty")
        );
    }

    /// The whole point of the `;` separator: `C:\Users\me\.kube\config` must
    /// survive as a single entry on Windows, where `:` would split it at the
    /// drive letter. On unix the same string is `:`-split, so the first entry is
    /// the bare `C` — that platform can't meaningfully parse a Windows path,
    /// which is fine; this test just pins what each platform actually does.
    #[test]
    fn kubeconfig_windows_drive_letter_is_one_entry() {
        let first = first_kubeconfig_entry(r"C:\Users\me\.kube\config");
        let expected = if cfg!(windows) {
            r"C:\Users\me\.kube\config"
        } else {
            "C"
        };
        assert_eq!(first, Some(expected));
    }
}
