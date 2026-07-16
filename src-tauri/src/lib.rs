//! k7s Tauri application entry point (library crate).
//!
//! The frontend talks to Kubernetes exclusively through the Tauri commands
//! registered here; it never speaks to the API server directly. Live data is
//! pushed back to the webview via Tauri events (see the `kube` module).

mod commands;
mod error;
mod kube;

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
        .setup(|app| {
            // The ClientManager owns the active client and all connection-scoped
            // tasks. It needs an AppHandle (to emit events), which only exists once
            // setup runs — so it's constructed here and put into managed state.
            let manager = Arc::new(ClientManager::new(app.handle().clone()));
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_contexts,
            commands::default_kubeconfig_path,
            commands::import_kubeconfig,
            commands::load_prefs,
            commands::save_prefs,
            commands::connect,
            commands::get_yaml,
            commands::apply_yaml,
            commands::delete_resource,
            commands::scale_resource,
            commands::set_cordon,
            commands::get_events,
            commands::start_log_stream,
            commands::stop_log_stream,
            commands::start_shell,
            commands::shell_input,
            commands::shell_resize,
            commands::stop_shell,
            commands::start_port_forward,
            commands::stop_port_forward,
            commands::list_port_forwards,
        ])
        .run(tauri::generate_context!())
        .expect("error while running k7s application");
}
