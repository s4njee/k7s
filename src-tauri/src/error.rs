//! Application error type.
//!
//! Every Tauri command returns `Result<T, AppError>`. Internally `AppError` is an
//! enum (so `?` stays ergonomic); across the command boundary it serializes to a
//! typed [`ErrorEnvelope`] (B74-L): a stable machine `code`, a *safe* human
//! `message`, whether the failure is retryable, and a specific next `action`. The
//! raw Rust/debug string rides in `detail`, which the UI treats as diagnostics,
//! never as the primary message.
//!
//! `ErrorCode` / [`ErrorEnvelope`] are re-exported from the crate root so the
//! live harnesses in examples/ can assert on the classified codes.
//!
//! `AppError::Kube` carries the real `kube::Error` (not its display string) so the
//! envelope can classify a 401 from a 403 from a network blip instead of showing
//! the same text for all of them.

use kube::core::ErrorResponse;
use serde::{Serialize, Serializer};

/// Stable machine-readable error code (serde kebab-case, e.g. `forbidden`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// 401 — credentials invalid/expired (token, cert, exec output).
    Auth,
    /// 403 — RBAC denies the current identity.
    Forbidden,
    /// 404 — the object/resource isn't there.
    NotFound,
    /// 409 — the object changed since it was loaded.
    Conflict,
    /// TLS — the server certificate couldn't be verified.
    Tls,
    /// Transport — the API server didn't answer.
    Unreachable,
    /// The request exceeded its deadline.
    Timeout,
    /// The kubeconfig couldn't be parsed / points nowhere valid.
    Kubeconfig,
    /// An exec credential plugin binary isn't on PATH.
    ExecMissing,
    /// An exec credential plugin ran but failed (non-zero, bad output).
    ExecFailed,
    /// The manifest isn't valid YAML.
    InvalidYaml,
    /// Anything not classified above.
    Other,
}

impl std::fmt::Display for ErrorCode {
    /// The kebab-case wire form ("forbidden"), matching the serde rename.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            ErrorCode::Auth => "auth",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::NotFound => "not-found",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Tls => "tls",
            ErrorCode::Unreachable => "unreachable",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Kubeconfig => "kubeconfig",
            ErrorCode::ExecMissing => "exec-missing",
            ErrorCode::ExecFailed => "exec-failed",
            ErrorCode::InvalidYaml => "invalid-yaml",
            ErrorCode::Other => "other",
        };
        write!(f, "{s}")
    }
}

/// What the user can actually do about an error, as a label + explainer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionHint {
    /// Short button-ish label, e.g. "Check permissions".
    pub label: String,
    /// One-sentence explainer of the next step.
    pub hint: String,
}

/// The serialized error contract the frontend renders (B74-L).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEnvelope {
    pub code: ErrorCode,
    /// Safe, human-facing message. Raw Rust/debug text lives in `detail`.
    pub message: String,
    /// Whether retrying is likely to help.
    pub retryable: bool,
    pub action: ActionHint,
    /// The affected resource kind (e.g. "secrets"), when the error is about one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The raw error string — for diagnostics / advanced display, never the
    /// primary message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The single error type surfaced to the frontend across the command boundary.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// A kubeconfig was missing, malformed, or pointed nowhere valid.
    #[error("kubeconfig error: {0}")]
    Kubeconfig(String),

    /// Building a client or talking to the API server failed. Holds the real
    /// `kube::Error` so the envelope can classify auth/RBAC/transport/TLS/exec.
    #[error("kubernetes error: {0}")]
    Kube(kube::Error),

    /// A requested context/resource was not present.
    #[error("not found: {0}")]
    NotFound(String),

    /// YAML (de)serialization failed while reading or applying a manifest.
    #[error("yaml error: {0}")]
    Yaml(String),

    /// Catch-all for anything that doesn't fit the above.
    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// The stable machine code for this error.
    pub fn code(&self) -> ErrorCode {
        match self {
            AppError::Kube(e) => classify_kube(e).0,
            AppError::Kubeconfig(_) => ErrorCode::Kubeconfig,
            AppError::NotFound(_) => ErrorCode::NotFound,
            AppError::Yaml(_) => ErrorCode::InvalidYaml,
            AppError::Other(_) => ErrorCode::Other,
        }
    }

    /// The typed envelope the frontend receives. `kind`, when known (e.g. a
    /// watcher reporting for "secrets"), is set by the caller afterwards.
    pub fn envelope(&self) -> ErrorEnvelope {
        let (code, retryable, action) = match self {
            AppError::Kube(e) => classify_kube(e),
            AppError::Kubeconfig(_) => (
                ErrorCode::Kubeconfig,
                false,
                hint("Fix kubeconfig", "your kubeconfig couldn't be parsed — check it, then reconnect."),
            ),
            AppError::NotFound(_) => (
                ErrorCode::NotFound,
                false,
                hint("It's gone", "the object was deleted or never existed — refresh to confirm."),
            ),
            AppError::Yaml(_) => (
                ErrorCode::InvalidYaml,
                false,
                hint("Fix the YAML", "the manifest isn't valid YAML — check it and try again."),
            ),
            AppError::Other(_) => (
                ErrorCode::Other,
                true,
                hint("Retry", "an unexpected error occurred — retry, or export diagnostics for more detail."),
            ),
        };
        ErrorEnvelope {
            code,
            message: code_message(code),
            retryable,
            action,
            kind: None,
            detail: Some(self.to_string()),
        }
    }

    /// Convenience: attach a resource kind to the envelope (watchers do this).
    pub fn envelope_for(&self, kind: &str) -> ErrorEnvelope {
        let mut env = self.envelope();
        env.kind = Some(kind.to_string());
        env
    }

    /// Build an envelope for a code the caller has already classified, given
    /// only the raw detail string. Used by the watchers (which hold the
    /// `kube::Error` by reference and can't move it into an [`AppError`]) and by
    /// the status poller, where the resource kind may not apply.
    pub fn envelope_for_code(code: ErrorCode, detail: impl Into<String>, kind: Option<&str>) -> ErrorEnvelope {
        let (retryable, action) = code_policy(code);
        ErrorEnvelope {
            code,
            message: code_message(code),
            retryable,
            action,
            kind: kind.map(|k| k.to_string()),
            detail: Some(detail.into()),
        }
    }
}

/// The retryability + next action for a code (shared by [`AppError::envelope`]
/// and [`AppError::envelope_for_code`] so the two can't drift).
fn code_policy(code: ErrorCode) -> (bool, ActionHint) {
    match code {
        ErrorCode::Auth => (true, hint("Re-authenticate", "your credentials expired or were rejected — check your kubeconfig and reconnect.")),
        ErrorCode::Forbidden => (false, hint("Check permissions", "the current user can't do this — ask your cluster admin for the missing RBAC role, or use a different context.")),
        ErrorCode::NotFound => (false, hint("It's gone", "the object was deleted or never existed — refresh to confirm.")),
        ErrorCode::Conflict => (true, hint("Reload", "the object changed since you loaded it — reload and try again.")),
        ErrorCode::Tls => (false, hint("Check certificate", "the server's TLS certificate couldn't be verified — check your cluster CA.")),
        ErrorCode::Unreachable => (true, hint("Check connectivity", "the API server didn't respond — is the cluster reachable?")),
        ErrorCode::Timeout => (true, hint("Retry", "the API server took too long to respond — retry, or check the cluster.")),
        ErrorCode::Kubeconfig => (false, hint("Fix kubeconfig", "your kubeconfig couldn't be parsed — check it, then reconnect.")),
        ErrorCode::ExecMissing => (false, hint("Install the plugin", "the kubeconfig's exec credential plugin isn't on your PATH — install it, or use a different context.")),
        ErrorCode::ExecFailed => (true, hint("Fix the plugin", "the exec credential plugin failed — check its output and that it emits a valid ExecCredential.")),
        ErrorCode::InvalidYaml => (false, hint("Fix the YAML", "the manifest isn't valid YAML — check it and try again.")),
        ErrorCode::Other => (true, hint("Retry", "an unexpected error occurred — retry, or export diagnostics for more detail.")),
    }
}

/// The safe category sentence for a code — the primary message.
fn code_message(code: ErrorCode) -> String {
    match code {
        ErrorCode::Auth => "authentication failed — your credentials are invalid or expired".into(),
        ErrorCode::Forbidden => "permission denied — the current identity can't do this here".into(),
        ErrorCode::NotFound => "not found — the object isn't there".into(),
        ErrorCode::Conflict => "conflict — the object changed since you loaded it".into(),
        ErrorCode::Tls => "TLS error — the server's certificate couldn't be verified".into(),
        ErrorCode::Unreachable => "cluster unreachable — the API server didn't respond".into(),
        ErrorCode::Timeout => "timed out talking to the API server".into(),
        ErrorCode::Kubeconfig => "invalid kubeconfig".into(),
        ErrorCode::ExecMissing => "the exec credential plugin isn't installed".into(),
        ErrorCode::ExecFailed => "the exec credential plugin failed".into(),
        ErrorCode::InvalidYaml => "invalid YAML".into(),
        ErrorCode::Other => "an unexpected error occurred".into(),
    }
}

fn hint(label: &str, hint: &str) -> ActionHint {
    ActionHint { label: label.into(), hint: hint.into() }
}

/// Classify a `kube::Error` into (code, retryable, action).
fn classify_kube(e: &kube::Error) -> (ErrorCode, bool, ActionHint) {
    match e {
        // API errors carry the HTTP code; classify the ones the app cares about.
        kube::Error::Api(err) => classify_api(err),
        // Transport-level failures: unreachable / reset / malformed response.
        kube::Error::Service(_) | kube::Error::HyperError(_) | kube::Error::HttpError(_) => (
            ErrorCode::Unreachable,
            true,
            hint("Check connectivity", "the API server didn't respond — is the cluster reachable?"),
        ),
        kube::Error::UpgradeConnection(_) => (
            ErrorCode::Unreachable,
            true,
            hint("Check connectivity", "the connection to the API server failed — retry."),
        ),
        kube::Error::ReadEvents(_) => (
            ErrorCode::Unreachable,
            true,
            hint("Retry", "the watch stream broke — it will reconnect automatically."),
        ),
        // TLS verification failures.
        kube::Error::RustlsTls(_) | kube::Error::TlsRequired => (
            ErrorCode::Tls,
            false,
            hint("Check certificate", "the server's TLS certificate couldn't be verified — check your cluster CA."),
        ),
        // Exec credential plugin failures.
        kube::Error::Auth(auth) => classify_auth(auth),
        // Config-loading failures (parse, merge, load).
        kube::Error::InferConfig(_)
        | kube::Error::ProxyProtocolUnsupported { .. }
        | kube::Error::ProxyProtocolDisabled { .. } => (
            ErrorCode::Kubeconfig,
            false,
            hint("Fix kubeconfig", "your kubeconfig couldn't be loaded — check it, then reconnect."),
        ),
        _ => (ErrorCode::Other, true, hint("Retry", "an unexpected error occurred — retry, or export diagnostics.")),
    }
}

/// Classify an HTTP-status API error by its code.
fn classify_api(err: &ErrorResponse) -> (ErrorCode, bool, ActionHint) {
    let retryable = (500..600).contains(&err.code) || err.code == 429;
    let (code, action) = match err.code {
        401 => (
            ErrorCode::Auth,
            hint("Re-authenticate", "your credentials expired or were rejected — check your kubeconfig and reconnect."),
        ),
        403 => (
            ErrorCode::Forbidden,
            hint("Check permissions", "the current user can't do this — ask your cluster admin for the missing RBAC role, or use a different context."),
        ),
        404 => (ErrorCode::NotFound, hint("It's gone", "the object was deleted or never existed — refresh to confirm.")),
        409 => (
            ErrorCode::Conflict,
            hint("Reload", "the object changed since you loaded it — reload and try again."),
        ),
        // 410 Gone: the watch's resourceVersion is stale; the app must resync.
        410 => (ErrorCode::NotFound, hint("Refresh", "the data is stale — refresh to resync.")),
        _ => (ErrorCode::Other, hint("Retry", "the API server refused the request — check the response for details.")),
    };
    (code, retryable, action)
}

/// Classify an auth/exec-credential failure.
/// The trailing `_` covers OAuth/OIDC variants that only exist when kube's
/// `oauth`/`oidc` features are enabled (they aren't here), so it's unreachable
/// in this build but keeps the match total if those features are ever turned on.
#[allow(unreachable_patterns)]
fn classify_auth(e: &kube::client::AuthError) -> (ErrorCode, bool, ActionHint) {
    use kube::client::AuthError;
    match e {
        // The exec binary couldn't be spawned — most often "not found" on PATH.
        AuthError::AuthExecStart(io) if io.kind() == std::io::ErrorKind::NotFound => (
            ErrorCode::ExecMissing,
            false,
            hint("Install the plugin", "the kubeconfig's exec credential plugin isn't on your PATH — install it, or use a different context."),
        ),
        // The exec plugin ran but failed (non-zero exit, bad output, bad expiry).
        AuthError::AuthExecStart(_)
        | AuthError::AuthExecRun { .. }
        | AuthError::AuthExecParse(_)
        | AuthError::AuthExecSerialize(_)
        | AuthError::ExecPluginFailed
        | AuthError::MalformedTokenExpirationDate(_) => (
            ErrorCode::ExecFailed,
            true,
            hint("Fix the plugin", "the exec credential plugin failed — check its output and that it emits a valid ExecCredential."),
        ),
        AuthError::MissingCommand | AuthError::ExecMissingClusterInfo => (
            ErrorCode::Kubeconfig,
            false,
            hint("Fix kubeconfig", "the kubeconfig's exec block is incomplete — check it and reconnect."),
        ),
        // Plain token/cert problems.
        AuthError::InvalidBearerToken(_)
        | AuthError::InvalidBasicAuth(_)
        | AuthError::UnrefreshableTokenResponse
        | AuthError::AuthExec(_)
        | AuthError::ReadTokenFile(..)
        | AuthError::ParseTokenKey(_) => (
            ErrorCode::Auth,
            true,
            hint("Re-authenticate", "your credentials couldn't be read or refreshed — check your kubeconfig and reconnect."),
        ),
        AuthError::NoValidNativeRootCA(_) => (
            ErrorCode::Tls,
            false,
            hint("Check certificate", "no trusted root CA is available to verify the server — check your cluster CA."),
        ),
        _ => (ErrorCode::Auth, true, hint("Re-authenticate", "an authentication step failed — check your kubeconfig and reconnect.")),
    }
}

// Serialize the error as its typed envelope. Tauri sends this to the webview,
// where the UI renders the safe message + next action (see src/lib/errors.ts).
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.envelope().serialize(serializer)
    }
}

// Convenience conversions so `?` works against the crates we use most. Keeping
// the real `kube::Error` (rather than its string) is what lets the envelope
// classify auth/RBAC/transport/TLS/exec failures.
impl From<kube::Error> for AppError {
    fn from(e: kube::Error) -> Self {
        AppError::Kube(e)
    }
}

impl From<kube::config::KubeconfigError> for AppError {
    fn from(e: kube::config::KubeconfigError) -> Self {
        AppError::Kubeconfig(e.to_string())
    }
}

impl From<serde_yaml::Error> for AppError {
    fn from(e: serde_yaml::Error) -> Self {
        AppError::Yaml(e.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

/// Shorthand for command return types.
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// HTTP codes map to the stable codes the UI keys on.
    #[test]
    fn api_codes_classify() {
        let api = |code: u16| kube::Error::Api(ErrorResponse {
            status: "Failure".into(),
            message: "secrets is forbidden: forbidden".into(),
            reason: "Forbidden".into(),
            code,
        });
        let env = AppError::from(api(401)).envelope();
        assert_eq!(env.code, ErrorCode::Auth);
        assert!(!env.retryable);
        assert!(!env.message.contains("Rust") && !env.message.contains("forbidden"));

        let env = AppError::from(api(403)).envelope();
        assert_eq!(env.code, ErrorCode::Forbidden);

        let env = AppError::from(api(404)).envelope();
        assert_eq!(env.code, ErrorCode::NotFound);

        let env = AppError::from(api(409)).envelope();
        assert_eq!(env.code, ErrorCode::Conflict);

        // 5xx / 429 are retryable.
        let env = AppError::from(api(503)).envelope();
        assert_eq!(env.code, ErrorCode::Other);
        assert!(env.retryable);
        let env = AppError::from(api(429)).envelope();
        assert!(env.retryable);
    }

    /// Transport failures are unreachable + retryable.
    #[test]
    fn transport_is_unreachable_and_retryable() {
        let e = kube::Error::Service("connection refused".into());
        let env = AppError::from(e).envelope();
        assert_eq!(env.code, ErrorCode::Unreachable);
        assert!(env.retryable);
    }

    /// An exec plugin that can't be spawned (binary not found) is ExecMissing;
    /// one that runs but fails is ExecFailed.
    #[test]
    fn exec_errors_classify_missing_vs_failed() {
        use kube::client::AuthError;
        let missing = kube::Error::Auth(AuthError::AuthExecStart(
            std::io::Error::from(std::io::ErrorKind::NotFound),
        ));
        assert_eq!(AppError::from(missing).code(), ErrorCode::ExecMissing);

        let bad_out = kube::Error::Auth(AuthError::AuthExecParse(
            serde_json::from_str::<serde_json::Value>("nope").unwrap_err(),
        ));
        let env = AppError::from(bad_out).envelope();
        assert_eq!(env.code, ErrorCode::ExecFailed);
        assert!(env.retryable);

        // An ExitStatus built the portable way: run a command that fails.
        let failed = std::process::Command::new("false").status().unwrap();
        let nonzero = kube::Error::Auth(AuthError::AuthExecRun {
            cmd: "plugin".into(),
            status: failed,
            out: std::process::Output { stdout: vec![], stderr: vec![], status: failed },
        });
        assert_eq!(AppError::from(nonzero).code(), ErrorCode::ExecFailed);
    }

    /// Plain TLS and config failures classify to their own codes.
    #[test]
    fn tls_and_config_classify() {
        let tls = kube::Error::TlsRequired;
        assert_eq!(AppError::from(tls).code(), ErrorCode::Tls);

        let cfg = AppError::Kubeconfig("boom".into());
        assert_eq!(cfg.code(), ErrorCode::Kubeconfig);
        assert!(!cfg.envelope().retryable);

        let yaml = AppError::Yaml("bad yaml".into());
        assert_eq!(yaml.code(), ErrorCode::InvalidYaml);
    }

    /// The envelope always carries a safe message and a specific action; the raw
    /// string stays in detail (diagnostics), not the primary message.
    #[test]
    fn envelope_has_action_and_keeps_raw_in_detail() {
        let env = AppError::from(kube::Error::Api(ErrorResponse {
            status: "Failure".into(),
            message: "forbidden".into(),
            reason: "Forbidden".into(),
            code: 403,
        }))
        .envelope_for("secrets");
        assert_eq!(env.kind.as_deref(), Some("secrets"));
        assert!(!env.message.contains("forbidden"), "safe message, not the raw API text");
        assert!(!env.action.label.is_empty() && !env.action.hint.is_empty());
        assert!(env.detail.as_deref().is_some_and(|d| d.contains("Forbidden")), "raw text kept in detail");
    }
}
