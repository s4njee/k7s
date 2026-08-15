//! k7s Tauri application entry point (library crate).
//!
//! The frontend talks to Kubernetes exclusively through the Tauri commands
//! registered here; it never speaks to the API server directly. Live data is
//! pushed back to the webview via Tauri events (see the `kube` module).

pub mod commands;
mod crash_reporting;
mod diagnostics;
mod error;
mod logging;
// Public so the live verification harnesses in examples/ can exercise the real
// mappers rather than a copy of them; nothing outside this crate consumes it.
pub mod kube;

pub use error::{AppError, AppResult};

use kube::ClientManager;
use std::sync::Arc;
use tauri::menu::MenuItemBuilder;
// macOS keeps the standard menu and only appends to its File submenu; the other
// platforms build a File menu from scratch, so each branch needs its own types.
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItemKind};
#[cfg(not(target_os = "macos"))]
use tauri::menu::{MenuBuilder, SubmenuBuilder};
// Brings `.manage()` into scope for the App in the setup hook, and `.emit()`
// into scope for the menu handler.
use tauri::{Emitter, Manager};

/// Tauri event emitted when the native File > Settings… item is chosen; the
/// frontend opens its settings dialog on it.
const SETTINGS_OPEN_EVENT: &str = "settings-open";
/// Tauri event emitted when File > Export Diagnostics… is chosen; the frontend
/// runs the export (B73).
const EXPORT_DIAGNOSTICS_EVENT: &str = "export-diagnostics";

/// Build and run the Tauri application.
///
/// Kept in the library crate so integration tests can construct pieces of it
/// without spawning a real window.
pub fn run() {
    tauri::Builder::default()
        // The shell plugin backs the capability that lets us open external URLs
        // (e.g. links in the UI) in the user's default browser.
        .plugin(tauri_plugin_shell::init())
        // The dialog plugin backs the native file picker for "Import kubeconfig".
        .plugin(tauri_plugin_dialog::init())
        // Backs the clipboard write in the Secret "copy value" command (B37).
        .plugin(tauri_plugin_clipboard_manager::init())
        // Backs the native problem notifications (B50).
        .plugin(tauri_plugin_notification::init())
        // Automatic updates (B72): a passive endpoint check + signature-verified
        // download/install, driven by the frontend's useUpdates hook. The plugin
        // is inert until `check()` is called, so dev/demo builds are unaffected.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // `relaunch()` for applying an installed update (B72).
        .plugin(tauri_plugin_process::init())
        // Remembers the window's size, position and monitor across launches (B22),
        // saving on exit and restoring on show. There's nothing to gate for demo
        // mode: that runs as a plain browser page with no Tauri backend at all, so
        // this code isn't in the build to begin with.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // Logging first (B73): stderr + a rotating file under the app log
            // dir, at the level the user last chose (or RUST_LOG in a dev
            // build). Everything that follows — including panics — lands there.
            let prefs = commands::read_prefs(app.handle());
            logging::init(
                app.handle(),
                prefs.log_level.as_deref().unwrap_or(logging::DEFAULT_LEVEL),
            );
            crash_reporting::install();
            crash_reporting::set_config(
                prefs.crash_reporting.unwrap_or(false),
                prefs.crash_report_endpoint.unwrap_or_default(),
            );

            // The ClientManager owns the active client and all connection-scoped
            // tasks. It needs an AppHandle (to emit events), which only exists once
            // setup runs — so it's constructed here and put into managed state.
            let manager = Arc::new(ClientManager::new(app.handle().clone()));
            app.manage(manager);
            save_window_state_on_sigterm(app.handle().clone());
            // File > Settings… / Export Diagnostics…, which open their flows via
            // events the frontend listens for.
            setup_menu(app)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "file-settings" => {
                    let _ = app.emit(SETTINGS_OPEN_EVENT, ());
                }
                "file-export-diagnostics" => {
                    let _ = app.emit(EXPORT_DIAGNOSTICS_EVENT, ());
                }
                _ => {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_contexts,
            commands::default_kubeconfig_path,
            commands::import_kubeconfig,
            commands::export_context_kubeconfig,
            commands::restore_imports,
            commands::load_prefs,
            commands::save_prefs,
            commands::connect,
            commands::disconnect,
            commands::cluster_overview,
            commands::get_yaml,
            commands::get_diff,
            commands::apply_yaml,
            commands::dry_run_yaml,
            commands::create_resource,
            commands::copy_secret_value,
            commands::notify_problem,
            commands::delete_resource,
            commands::scale_resource,
            commands::set_cordon,
            commands::restart_pod,
            commands::restart_rollout,
            commands::undo_rollout,
            commands::rollback_release,
            commands::uninstall_release,
            commands::set_cronjob_suspend,
            commands::run_cronjob,
            commands::retry_job,
            commands::drain_node,
            commands::drain_preview,
            commands::get_events,
            commands::get_properties,
            commands::get_topology,
            commands::watch_custom_kind,
            commands::node_history,
            commands::pod_history,
            commands::watch_node_stats,
            commands::unwatch_node_stats,
            commands::unwatch_custom_kind,
            commands::start_log_stream,
            commands::export_logs,
            commands::stop_log_stream,
            commands::start_workload_logs,
            commands::export_workload_logs,
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
            // Diagnostics (B73): frontend errors → the log (+ crash reporting),
            // and the "Export diagnostics…" bundle.
            commands::log_frontend_error,
            commands::export_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running k7s application");
}

/// Install the native app menu.
///
/// macOS's default menu already has a File submenu (with Close Window), so the
/// "Settings…" and "Export Diagnostics…" items are appended to it — leaving the
/// app, Edit, View and Window menus intact, so Cmd+Q / Cmd+C and friends keep
/// working. On Windows/Linux there is no menu at all, so this creates a File
/// menu of its own with both items and Quit. Choosing an item emits its event
/// (see the handler in `run`).
fn setup_menu(app: &tauri::App) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("file-settings", "Settings…")
        // Cmd+, on macOS, Ctrl+, elsewhere — the conventional preferences key.
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let export = MenuItemBuilder::with_id("file-export-diagnostics", "Export Diagnostics…")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;

    #[cfg(target_os = "macos")]
    {
        let menu = Menu::default(app.handle())?;
        for item in menu.items()? {
            if let MenuItemKind::Submenu(file) = item {
                if file.text()? == "File" {
                    file.append(&settings)?;
                    file.append(&export)?;
                    break;
                }
            }
        }
        app.set_menu(menu)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let file = SubmenuBuilder::with_id(app, "file", "File", true)
            .item(&settings)
            .separator()
            .item(&export)
            .separator()
            .quit()
            .build()?;
        let menu = MenuBuilder::new(app).item(&file).build()?;
        app.set_menu(menu)?;
    }

    Ok(())
}

/// Save window geometry when the process is killed behind Tauri's back (B22).
///
/// The window-state plugin saves when the app quits *through Tauri* — Cmd+Q,
/// closing the window, or app exit — on every platform (its `CloseRequested`
/// and `Exit` hooks). It never sees a process killed by the OS, which is exactly
/// how `dev/run.sh` stops the app (SIGTERM), so without this the geometry would
/// never survive a development session: B22 would be dead in the workflow B24
/// standardised. Windows has no SIGTERM, so its arm waits on the session-end
/// ctrl events instead.
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

/// Windows analogue of the SIGTERM handler: a session ending.
///
/// Windows delivers CTRL_CLOSE / CTRL_LOGOFF / CTRL_SHUTDOWN to processes that
/// registered a console-ctrl handler; whichever fires, the process is being torn
/// down without a Tauri quit, so save and exit. The everyday cases (closing the
/// window, app quit) are already covered by the plugin's own hooks.
///
/// Caveat: the exact delivery of these events to a GUI process is one of the
/// things the B71 Windows-host pass must verify — this arm is written to the
/// tokio 1.52 API and compiled only on Windows.
#[cfg(windows)]
fn save_window_state_on_sigterm(app: tauri::AppHandle) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};

    tauri::async_runtime::spawn(async move {
        let (mut close, mut logoff, mut shutdown) = match (
            tokio::signal::windows::ctrl_close(),
            tokio::signal::windows::ctrl_logoff(),
            tokio::signal::windows::ctrl_shutdown(),
        ) {
            (Ok(c), Ok(l), Ok(s)) => (c, l, s),
            // A handler that can't be installed means nothing to wait for; the
            // plugin's save-on-close/exit still covers the normal cases.
            _ => return,
        };
        tokio::select! {
            _ = close.recv() => {}
            _ = logoff.recv() => {}
            _ = shutdown.recv() => {}
        }
        if let Err(e) = app.save_window_state(StateFlags::all()) {
            tracing::warn!("could not save window state at session end: {e}");
        }
        app.exit(0);
    });
}

#[cfg(not(any(unix, windows)))]
fn save_window_state_on_sigterm(_app: tauri::AppHandle) {}
