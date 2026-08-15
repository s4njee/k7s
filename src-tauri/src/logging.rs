//! File logging (B73): every trace also lands in a rotating file under the
//! platform app log dir, so a user running the bundled .app has something to
//! attach to a bug report instead of "run it from a terminal". stderr is kept
//! (the dev convenience), and the verbosity is reloadable from Settings at
//! runtime — no restart needed to capture a crash-loop at debug level.

use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tracing_subscriber::prelude::*;
use tracing_subscriber::reload;
use tracing_subscriber::{EnvFilter, Registry};

/// Keep-alives for the non-blocking writers; dropping a guard stops its writer
/// flushing, so they live for the process.
struct LogGuards {
    _file: Option<tracing_appender::non_blocking::WorkerGuard>,
    _stderr: tracing_appender::non_blocking::WorkerGuard,
}

static GUARDS: OnceLock<LogGuards> = OnceLock::new();
static FILTER: OnceLock<reload::Handle<EnvFilter, Registry>> = OnceLock::new();
/// The level the reload handle currently holds — needed by the diagnostics
/// export, which records it in versions.json.
static CURRENT_LEVEL: Mutex<&'static str> = Mutex::new(DEFAULT_LEVEL);

/// The verbosities the Settings select offers, least → most.
pub const LEVELS: [&str; 5] = ["error", "warn", "info", "debug", "trace"];
pub const DEFAULT_LEVEL: &str = "info";

/// Build the subscriber: a reloadable filter, a rotating file writer under
/// `app_log_dir`, and stderr. Called once, first thing in setup. `initial_level`
/// comes from prefs; a `RUST_LOG` env var (a dev machine) wins over it.
///
/// The file half is best-effort: no app log dir, or a dir that can't be opened,
/// means stderr only — logging must never be a reason the app fails to start.
pub fn init(app: &tauri::AppHandle, initial_level: &str) {
    let level = std::env::var("RUST_LOG").unwrap_or_else(|_| initial_level.to_string());
    let (filter, handle) =
        reload::Layer::new(EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new(DEFAULT_LEVEL)));

    let (file_writer, file_guard) = match app.path().app_log_dir() {
        Ok(dir) => match tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .max_log_files(5)
            .filename_prefix("k7s")
            .filename_suffix("log")
            .build(&dir)
        {
            Ok(appender) => {
                let (writer, guard) = tracing_appender::non_blocking(appender);
                (Some(writer), Some(guard))
            }
            Err(e) => {
                eprintln!("k7s: could not open the app log dir ({e}); logging to stderr only");
                (None, None)
            }
        },
        Err(e) => {
            eprintln!("k7s: no app log dir ({e}); logging to stderr only");
            (None, None)
        }
    };

    let (stderr_writer, stderr_guard) = tracing_appender::non_blocking(std::io::stderr());

    // Layers collected into a Vec so the file half can be absent (no app log
    // dir) without the two fmt layers' types conflicting.
    let mut layers: Vec<Box<dyn tracing_subscriber::Layer<Registry> + Send + Sync>> =
        vec![Box::new(filter)];
    if let Some(writer) = file_writer {
        layers.push(Box::new(tracing_subscriber::fmt::layer().with_writer(writer)));
    }
    layers.push(Box::new(
        tracing_subscriber::fmt::layer().with_writer(stderr_writer),
    ));
    tracing_subscriber::registry().with(layers).init();

    let _ = GUARDS.set(LogGuards { _file: file_guard, _stderr: stderr_guard });
    let _ = FILTER.set(handle);
}

/// Reload the log level at runtime (the Settings "Log level" select).
pub fn set_level(level: &str) {
    if let Some(handle) = FILTER.get() {
        if let Ok(filter) = EnvFilter::try_new(level) {
            let _ = handle.reload(filter);
            if let Some(canonical) = LEVELS.iter().find(|l| **l == level) {
                *CURRENT_LEVEL.lock().unwrap() = canonical;
            }
        }
    }
}

/// The level the filter currently holds, as a `'static` from [`LEVELS`].
pub fn current_level() -> &'static str {
    *CURRENT_LEVEL.lock().unwrap()
}

/// True when `level` is one of [`LEVELS`] — the backstop behind the Settings
/// sanitizer, so a hand-edited prefs.json can't smuggle in a junk directive.
pub fn is_valid_level(level: &str) -> bool {
    LEVELS.contains(&level)
}
