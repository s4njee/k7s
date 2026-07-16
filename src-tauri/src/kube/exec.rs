//! Interactive shell (exec) into a pod container (B4).
//!
//! Each session runs `exec` with a TTY and pumps three channels:
//!   - container stdout  → emitted as `shell-out:{id}` (text chunks)
//!   - frontend stdin    → written to the container (via `shell_input`)
//!   - terminal resize   → forwarded to the container (via `shell_resize`)
//!
//! On exit/error it emits `shell-closed:{id}`. The pump task owns the
//! AttachedProcess, so aborting the task (on stop / disconnect) tears down the
//! exec connection.

use crate::error::AppError;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{AttachParams, Api, TerminalSize};
use kube::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// Prefix for stdout chunk events (`shell-out:{stream_id}`).
pub const SHELL_OUT_PREFIX: &str = "shell-out:";
/// Prefix for session-closed events (`shell-closed:{stream_id}`).
pub const SHELL_CLOSED_PREFIX: &str = "shell-closed:";

/// A stdout chunk sent to the frontend.
#[derive(Serialize, Clone)]
struct ShellOut {
    data: String,
}

/// Try bash, fall back to sh — gives a nicer prompt where bash exists. We probe
/// with `command -v` first: a *failed* `exec` would terminate the POSIX shell
/// before any `||` fallback could run, so we must only exec a binary we know
/// exists (many images, e.g. redis, have no /bin/bash).
const SHELL_CMD: [&str; 3] = [
    "/bin/sh",
    "-c",
    "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi",
];

/// Run a shell session until the process exits or the task is aborted.
#[allow(clippy::too_many_arguments)]
pub async fn run_shell(
    client: Client,
    app: AppHandle,
    stream_id: String,
    namespace: String,
    pod: String,
    container: String,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    mut resize_rx: mpsc::Receiver<(u16, u16)>,
) {
    let closed_event = format!("{}{}", SHELL_CLOSED_PREFIX, stream_id);
    let reason = match exec_pump(
        client,
        &app,
        &stream_id,
        &namespace,
        &pod,
        &container,
        &mut input_rx,
        &mut resize_rx,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => e.to_string(),
    };
    let _ = app.emit(&closed_event, reason);
}

#[allow(clippy::too_many_arguments)]
async fn exec_pump(
    client: Client,
    app: &AppHandle,
    stream_id: &str,
    namespace: &str,
    pod: &str,
    container: &str,
    input_rx: &mut mpsc::Receiver<Vec<u8>>,
    resize_rx: &mut mpsc::Receiver<(u16, u16)>,
) -> Result<String, AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let ap = AttachParams::default()
        .stdin(true)
        .stdout(true)
        .stderr(false) // tty merges stderr into stdout
        .tty(true)
        .container(container.to_string());

    let mut proc = api
        .exec(pod, SHELL_CMD, &ap)
        .await
        .map_err(|e| AppError::Kube(e.to_string()))?;

    let mut stdout = proc.stdout().ok_or_else(|| AppError::Other("no stdout".into()))?;
    let mut stdin = proc.stdin().ok_or_else(|| AppError::Other("no stdin".into()))?;
    // terminal_size() is a futures mpsc Sender (bounded); use try_send (non-async).
    let mut ts_tx = proc.terminal_size();

    let out_event = format!("{}{}", SHELL_OUT_PREFIX, stream_id);
    let mut buf = [0u8; 8192];

    loop {
        tokio::select! {
            // Container output → frontend.
            read = stdout.read(&mut buf) => match read {
                Ok(0) => return Ok("session ended".into()),
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(&out_event, ShellOut { data });
                }
                Err(e) => return Err(AppError::Other(e.to_string())),
            },
            // Frontend keystrokes → container stdin.
            input = input_rx.recv() => match input {
                Some(bytes) => {
                    if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                        return Ok("stdin closed".into());
                    }
                }
                None => return Ok("input closed".into()),
            },
            // Terminal resize → container.
            size = resize_rx.recv() => {
                if let Some((cols, rows)) = size {
                    if let Some(tx) = ts_tx.as_mut() {
                        let _ = tx.try_send(TerminalSize { width: cols, height: rows });
                    }
                }
            }
        }
    }
}
