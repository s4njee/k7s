//! k7s Tauri application entry point (library crate).
//!
//! The frontend talks to Kubernetes exclusively through the Tauri commands
//! registered here; it never speaks to the API server directly. Live data is
//! pushed back to the webview via Tauri events (see the `kube` module).

mod commands;
mod error;
// Public so the live verification harnesses in examples/ can exercise the real
// mappers rather than a copy of them; nothing outside this crate consumes it.
pub mod kube;

pub use error::{AppError, AppResult};

use kube::ClientManager;
use std::sync::Arc;
// Brings `.manage()` into scope for the App in the setup hook.
use tauri::Manager;

/// Build and run the Tauri application.
///
/// Kept in the library crate so integration tests can construct pieces of it
/// without spawning a real window.
pub fn run() {
    // Structured logs to stderr; level controlled by RUST_LOG (defaults to info).
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        // The shell plugin backs the capability that lets us open external URLs
        // (e.g. links in the UI) in the user's default browser.
        .plugin(tauri_plugin_shell::init())
        // The dialog plugin backs the native file picker for "Import kubeconfig".
        .plugin(tauri_plugin_dialog::init())
        // Remembers the window's size, position and monitor across launches (B22),
        // saving on exit and restoring on show. There's nothing to gate for demo
        // mode: that runs as a plain browser page with no Tauri backend at all, so
        // this code isn't in the build to begin with.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // The ClientManager owns the active client and all connection-scoped
            // tasks. It needs an AppHandle (to emit events), which only exists once
            // setup runs — so it's constructed here and put into managed state.
            let manager = Arc::new(ClientManager::new(app.handle().clone()));
            app.manage(manager);
            save_window_state_on_sigterm(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_contexts,
            commands::default_kubeconfig_path,
            commands::import_kubeconfig,
            commands::restore_imports,
            commands::load_prefs,
            commands::save_prefs,
            commands::connect,
            commands::get_yaml,
            commands::apply_yaml,
            commands::dry_run_yaml,
            commands::delete_resource,
            commands::scale_resource,
            commands::set_cordon,
            commands::restart_pod,
            commands::restart_rollout,
            commands::drain_node,
            commands::get_events,
            commands::get_properties,
            commands::watch_custom_kind,
            commands::node_history,
            commands::watch_node_stats,
            commands::unwatch_node_stats,
            commands::unwatch_custom_kind,
            commands::start_log_stream,
            commands::export_logs,
            commands::stop_log_stream,
            commands::start_shell,
            commands::shell_input,
            commands::shell_resize,
            commands::stop_shell,
            commands::start_node_shell,
            commands::stop_node_shell,
            commands::start_port_forward,
            commands::start_service_port_forward,
            commands::stop_port_forward,
            commands::list_port_forwards,
        ])
        .run(tauri::generate_context!())
        .expect("error while running k7s application");
}

/// Save window geometry when the process is asked to terminate (B22).
///
/// The window-state plugin saves when the app quits *through Tauri* — Cmd+Q, or
/// closing the window. It never sees a SIGTERM, which is exactly how `dev/run.sh`
/// stops the app, so without this the geometry would never survive a development
/// session: B22 would be dead in the workflow B24 standardised.
///
/// Unix-only, which is every platform this ships on today; elsewhere the
/// plugin's own save-on-quit is the whole story.
#[cfg(unix)]
fn save_window_state_on_sigterm(app: tauri::AppHandle) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};

    tauri::async_runtime::spawn(async move {
        let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            // Nothing to do if the handler can't be installed; the app still exits
            // on SIGTERM, just without remembering where it was.
            return;
        };
        term.recv().await;
        if let Err(e) = app.save_window_state(StateFlags::all()) {
            tracing::warn!("could not save window state on SIGTERM: {e}");
        }
        // Exit through Tauri so the rest of its shutdown still runs.
        app.exit(0);
    });
}

#[cfg(not(unix))]
fn save_window_state_on_sigterm(_app: tauri::AppHandle) {}
