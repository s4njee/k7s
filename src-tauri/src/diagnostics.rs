//! Diagnostics bundle (B73): the "Export diagnostics…" zip. Everything in it is
//! shareable — the log tail, versions, settings and boundary trace are scrubbed
//! of server URLs, bearer tokens, base64 blobs and the user's home path before
//! they're written, so a bug report can't leak the cluster's identity. The same
//! [`redact`] pass guards the opt-in crash-report body (crash_reporting.rs).

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::AppError;
use crate::AppResult;

/// Bytes of the newest log file to include. At debug level the file gets large;
/// the part that explains a crash is always the tail.
const LOG_TAIL_BYTES: u64 = 2 * 1024 * 1024;

fn url_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    // `r#"…"#` so the double quote inside the character class isn't the raw
    // string terminator.
    RE.get_or_init(|| regex::Regex::new(r#"https?://[^\s"'<>`]+"#).unwrap())
}

fn auth_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)authorization:\s*bearer\s+\S+").unwrap())
}

fn base64_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9+/]{40,}={0,2}").unwrap())
}

/// The redaction pass applied to exported log/settings/trace text and to crash
/// reports: URLs (a kubeconfig server, kube error strings), bearer tokens, long
/// base64 blobs (cert data, tokens), and the user's home path.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    if let Some(home) = home_dir() {
        let home = home.to_string_lossy();
        if !home.is_empty() {
            out = out.replace(home.as_ref(), "<home>");
        }
    }
    out = url_re().replace_all(&out, "<url>").into_owned();
    out = auth_re()
        .replace_all(&out, "authorization: Bearer <redacted>")
        .into_owned();
    out = base64_re().replace_all(&out, "<base64>").into_owned();
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Write the diagnostics zip to `dest`. `context`/`cluster` come from the
/// frontend's connection state (the manager doesn't retain them) and are
/// redacted here in case a compromised webview tries to smuggle a URL in.
pub fn export(
    app: &tauri::AppHandle,
    dest: &Path,
    context: Option<&str>,
    cluster: Option<&str>,
    boundary_trace: Option<&str>,
) -> AppResult<()> {
    let file = std::fs::File::create(dest)
        .map_err(|e| AppError::Other(format!("cannot create {dest:?}: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let add = |zip: &mut zip::ZipWriter<std::fs::File>, name: &str, bytes: &[u8]| -> AppResult<()> {
        zip.start_file(name, opts)
            .map_err(|e| AppError::Other(format!("zip: {e}")))?;
        zip.write_all(bytes)
            .map_err(|e| AppError::Other(format!("zip: {e}")))?;
        Ok(())
    };

    if let Some(tail) = log_tail(app)? {
        add(&mut zip, "k7s.log", redact(&tail).as_bytes())?;
    }
    add(&mut zip, "versions.json", versions(context, cluster)?.as_bytes())?;
    add(&mut zip, "settings.json", settings_json(app)?.as_bytes())?;
    if let Some(trace) = boundary_trace {
        add(&mut zip, "boundary.txt", redact(trace).as_bytes())?;
    }

    zip.finish()
        .map_err(|e| AppError::Other(format!("zip: {e}")))?;
    Ok(())
}

/// versions.json: app/OS/arch and the connected cluster's *names* (never its
/// server URL) plus the current log level — the B73 "app/OS/cluster" payload.
fn versions(context: Option<&str>, cluster: Option<&str>) -> AppResult<String> {
    let meta = serde_json::json!({
        "app": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "connected": context.is_some() || cluster.is_some(),
        "context": context.map(redact),
        "cluster": cluster.map(redact),
        "logLevel": crate::logging::current_level(),
    });
    serde_json::to_string_pretty(&meta)
        .map_err(|e| AppError::Other(format!("versions: {e}")))
}

/// settings.json: the persisted prefs with paths and context names redacted —
/// imported kubeconfig paths, the last context, bookmark keys. Whatever else
/// remains (a shell command, a node-shell image) passes through [`redact`] too.
fn settings_json(app: &tauri::AppHandle) -> AppResult<String> {
    let mut prefs = prefs_json(app).unwrap_or(serde_json::Value::Null);
    if let Some(files) = prefs.get_mut("importedFiles").and_then(|v| v.as_array_mut()) {
        for f in files.iter_mut() {
            *f = serde_json::Value::String("<redacted>".into());
        }
    }
    if let Some(ctx) = prefs.get_mut("context") {
        *ctx = serde_json::Value::String("<redacted>".into());
    }
    if prefs.get("bookmarks").is_some() {
        prefs["bookmarks"] = serde_json::Value::String("<redacted>".into());
    }
    let text = serde_json::to_string_pretty(&prefs)
        .map_err(|e| AppError::Other(format!("settings: {e}")))?;
    Ok(redact(&text))
}

/// The persisted prefs as raw JSON, or Null when absent/unreadable.
fn prefs_json(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().ok()?;
    let text = std::fs::read_to_string(dir.join("prefs.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// The tail of the newest `k7s.YYYY-MM-DD.log` under the app log dir.
fn log_tail(app: &tauri::AppHandle) -> AppResult<Option<String>> {
    use tauri::Manager;
    let Some(dir) = app.path().app_log_dir().ok() else { return Ok(None) };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(None) };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("k7s.") && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    files.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    let Some(newest) = files.last() else { return Ok(None) };

    let Ok(meta) = std::fs::metadata(newest) else { return Ok(None) };
    let skip = meta.len().saturating_sub(LOG_TAIL_BYTES);
    let mut f = std::fs::File::open(newest)
        .map_err(|e| AppError::Other(format!("cannot read log: {e}")))?;
    f.seek(SeekFrom::Start(skip))
        .map_err(|e| AppError::Other(format!("cannot read log: {e}")))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| AppError::Other(format!("cannot read log: {e}")))?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The B73 acceptance's leak surface: URLs, bearer tokens, long base64
    /// blobs and the user's home path all come out redacted.
    #[test]
    fn redacts_urls_tokens_base64_and_home() {
        let home = home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
        let long_b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let input = format!(
            "connect to https://k8s.example.com:6443 with authorization: Bearer abc123; \
             kubeconfig at {home}/.kube/config; cert {long_b64}"
        );
        let out = redact(&input);
        assert!(!out.contains("https://"), "url leaked: {out}");
        assert!(!out.contains("Bearer abc123"), "token leaked: {out}");
        assert!(!out.contains(long_b64), "base64 blob leaked");
        if !home.is_empty() {
            assert!(!out.contains(&home), "home path leaked: {out}");
        }
    }

    /// Ordinary prose (short words, no URLs) passes through untouched.
    #[test]
    fn redact_leaves_plain_text_alone() {
        let out = redact("watch error: resource kind 'pods' is not served on the API server");
        assert!(out.contains("pods"));
        assert!(out.contains("API server"));
        assert!(!out.contains("<url>"));
    }
}
