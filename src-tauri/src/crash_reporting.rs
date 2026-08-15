//! Opt-in crash reporting (B73): Rust panics and React render errors only — no
//! analytics, no usage telemetry, ever. Off by default; the Settings consent
//! toggle plus an endpoint arms it.
//!
//! The invariant the acceptance tests rest on: when off, `report` is a strict
//! no-op that never even builds an HTTP client, so "zero network calls when off"
//! holds by construction. The endpoint is user-configured (Sentry / self-hosted
//! GlitchTip), so nothing ships pointing at a specific vendor.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[derive(Clone, Default)]
struct Config {
    enabled: bool,
    endpoint: String,
}

static CONFIG: OnceLock<Mutex<Config>> = OnceLock::new();

fn config() -> std::sync::MutexGuard<'static, Config> {
    CONFIG
        .get_or_init(|| Mutex::new(Config::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Whether a report would actually be sent (consent on AND an endpoint set).
pub fn is_enabled() -> bool {
    let cfg = config();
    cfg.enabled && !cfg.endpoint.is_empty()
}

/// Apply the consent + endpoint from Settings (called at boot from prefs and on
/// every save).
pub fn set_config(enabled: bool, endpoint: String) {
    *config() = Config {
        enabled,
        endpoint: endpoint.trim().to_string(),
    };
}

/// Install the global panic hook. Always writes the panic + backtrace to the
/// log file (that's diagnostics, unconditional); only POSTs it when armed.
/// Replaces the default hook, which is why this lives in `run()` — never called
/// under `cargo test`.
pub fn install() {
    std::panic::set_hook(Box::new(|info| {
        // force_capture() so the file gets a stack even without RUST_BACKTRACE.
        let backtrace = std::backtrace::Backtrace::force_capture();
        let detail = format!("{info}\n{backtrace}");
        tracing::error!(target: "panic", "panic:\n{detail}");
        report("panic", &detail);
    }));
}

/// A frontend (React) error hit the boundary or the window — B73 forwards these
/// to the same log as everything else, and to the reporting endpoint when armed.
pub fn frontend_error(source: &str, message: &str, stack: Option<&str>) {
    let detail = format!("[{source}] {message}\n{}", stack.unwrap_or(""));
    report("frontend_error", &detail);
}

/// Send a report — or return without touching the network when not armed.
fn report(kind: &str, detail: &str) {
    if !is_enabled() {
        return;
    }
    let endpoint = config().endpoint.clone();
    // Build the client only now, armed: the off-path never constructs one.
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(10)).build() else {
        return;
    };
    let body = serde_json::json!({
        "app": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "event": kind,
        "message": crate::diagnostics::redact(detail),
    });
    tauri::async_runtime::spawn(async move {
        let _ = client.post(&endpoint).json(&body).send().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One sequential pass over the whole gate so the shared CONFIG can't be
    /// raced by parallel tests: default off, consent-without-endpoint off,
    /// consent+endpoint on, then off again. The "zero network calls when off"
    /// acceptance holds by construction — `report` returns before the reqwest
    /// client is ever built.
    #[test]
    fn gating_off_until_consent_and_endpoint() {
        assert!(!is_enabled(), "off by default");

        set_config(true, "".into());
        assert!(!is_enabled(), "consent without an endpoint sends nothing");

        set_config(true, "https://glitchtip.example.com/api/store/".into());
        assert!(is_enabled(), "consent + endpoint arms the reporter");

        // Disarmed: `report` is a no-op that never touches the network.
        set_config(false, "https://glitchtip.example.com/api/store/".into());
        assert!(!is_enabled());
        report("panic", "boom");
        report("frontend_error", "render failed");
    }
}
