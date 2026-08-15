//! Local kubectl terminal (B82): spawns the user's shell on a real pty with
//! `KUBECONFIG` pointed at a temp single-context file, so `kubectl` targets the
//! viewed cluster with zero setup.
//!
//! Reuses the pod shell's wire contract end-to-end: the session is registered
//! via the manager's shell registry, streams on `shell-out:{cid}:{id}` /
//! `shell-closed:{cid}:{id}`, and its input/resize ride `shell_input` /
//! `shell_resize`. The only difference from the in-cluster shells is *where* the
//! process runs — a local pty (portable-pty) instead of a kube exec attach.
//!
//! The temp kubeconfig follows the nodeshell discipline: a boot/start sweep
//! removes orphans, the session deletes its own file on a normal exit, and the
//! manager deletes it on stop/disconnect (an aborted task can't run async
//! cleanup). A crashed app leaves a file behind, which the next sweep catches.

use crate::error::{AppError, AppResult};
use crate::kube::{events, Cid};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// A stdout chunk sent to the frontend (same wire shape as the pod shell).
#[derive(Serialize, Clone)]
struct ShellOut {
    data: String,
}

/// The prefix every temp kubeconfig file carries, so the orphan sweep finds them.
const KUBECONFIG_FILE_PREFIX: &str = "k7s-kubeconfig-";

/// A spawned terminal: the pty master (read/write/resize) and the child process.
type SpawnedPty = (Box<dyn MasterPty + Send>, Box<dyn Child + Send + Sync>);

/// Owning wrapper over a pty child that *kills* it on drop.
///
/// Dropping a portable-pty/`std::process::Child` does not terminate the process —
/// it detaches, and the shell keeps running on its pty. That is fine for a pump
/// that watches the child exit naturally, but the B82 stop/disconnect path aborts
/// the pump task, and an aborted task cannot run async cleanup: without this guard
/// the shell would survive as an orphan, still attached to the (now unread) pty.
/// Holding the child in a guard whose `Drop` reaps it (try_wait) and otherwise
/// kills it makes *any* unwinding path — task abort, error return, normal exit —
/// end the process.
struct PtyChild(Box<dyn Child + Send + Sync>);

impl Drop for PtyChild {
    fn drop(&mut self) {
        // Reap an already-exited child (the normal `exit` path); kill a survivor
        // (task abort / disconnect). Killing a reaped pid risks a recycled one, so
        // only signal when try_wait proves the process is still running.
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            // SIGKILL is uninterruptible, so this returns promptly; waiting reaps
            // the process rather than leaving a zombie for the app's lifetime.
            let _ = self.0.wait();
        }
    }
}

/// Shown before the prompt when kubectl isn't on the resolved PATH — the shell
/// still works, but the whole point of the terminal doesn't.
const KUBECTL_MISSING_BANNER: &str = concat!(
    "\r\n\x1b[33m⚠ kubectl not found on PATH.\x1b[0m\r\n",
    "  The shell still works, but kubectl won't — install it to use this terminal:\r\n",
    "    macOS:   brew install kubectl\r\n",
    "    Windows: winget install Kubernetes.kubectl\r\n",
    "    Linux:   apt install kubectl   (or: snap install kubectl)\r\n\r\n",
);

/// The user's login-shell PATH (the B74 trick, built here for the terminal). A
/// packaged app launched from Finder has no login PATH — the shell spawned under
/// it would inherit a bare `/usr/bin:/bin:/usr/sbin:/sbin`, which is exactly
/// where Homebrew's `/opt/homebrew/bin/kubectl` is *not*. Spawn the login shell
/// once and capture the PATH it would have.
pub fn login_shell_path() -> String {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        for args in [&["-ilc", "echo -n \"$PATH\""][..], &["-lc", "echo -n \"$PATH\""][..]] {
            if let Ok(out) = std::process::Command::new(&shell).args(args).output() {
                if out.status.success() {
                    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !path.is_empty() {
                        return path;
                    }
                }
            }
        }
    }
    // Windows (PATH is global) or any fallback: the current environment.
    std::env::var("PATH").unwrap_or_default()
}

/// The command to run for a terminal: the user's preferred shell if set, else
/// `$SHELL` on Unix / PowerShell on Windows. The pref is a shell snippet, so —
/// like the in-cluster shell override — it runs through the default shell rather
/// than being exec'd directly (people type `env TERM=xterm-256color bash -l`).
pub fn default_shell_command(pref: &str) -> Vec<String> {
    let trimmed = pref.trim();
    if !trimmed.is_empty() {
        #[cfg(windows)]
        return vec!["powershell.exe".into(), "-Command".into(), trimmed.to_string()];
        #[cfg(not(windows))]
        return vec!["/bin/sh".into(), "-c".into(), format!("exec {trimmed}")];
    }
    #[cfg(windows)]
    return vec!["powershell.exe".into()];
    #[cfg(not(windows))]
    return vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())];
}

/// Resolve `kubectl` across a PATH string (the `:`/`;`-split form). Pure, so the
/// missing-kubectl banner is a decision the backend makes, not the frontend.
pub fn find_kubectl(path: &str) -> Option<String> {
    let exe = if cfg!(windows) { "kubectl.exe" } else { "kubectl" };
    let sep = if cfg!(windows) { ';' } else { ':' };
    path.split(sep)
        .filter(|p| !p.is_empty())
        .map(|p| Path::new(p).join(exe))
        .find(|p| p.is_file())
        .map(|p| p.display().to_string())
}

/// Write a single-context kubeconfig to a 0600 temp file (never the user's real
/// kubeconfig) and return its path.
pub fn write_temp_kubeconfig(yaml: &str) -> AppResult<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("{KUBECONFIG_FILE_PREFIX}{nanos}.yaml"));
    std::fs::write(&path, yaml)
        .map_err(|e| AppError::Other(format!("could not write temp kubeconfig: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

/// Delete orphaned temp kubeconfigs — the nodeshell discipline, applied to disk:
/// a crashed session can't clean up after itself, so a start sweeps the
/// leftovers. Called at app boot and before each new terminal.
pub fn sweep_orphan_kubeconfigs() {
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(KUBECONFIG_FILE_PREFIX) && name.ends_with(".yaml") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Spawn a shell on a fresh pty with `KUBECONFIG` and the login PATH set.
/// Returns the master (for read/write/resize) and the child. The temp kubeconfig
/// file's lifetime is the caller's.
pub fn spawn_shell_pty(
    argv: &[String],
    kubeconfig_path: &Path,
    login_path: &str,
    cols: u16,
    rows: u16,
) -> Result<SpawnedPty, AppError> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| AppError::Other(format!("could not open pty: {e}")))?;
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.env("KUBECONFIG", kubeconfig_path);
    cmd.env("PATH", login_path);
    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Other(format!("could not spawn shell: {e}")))?;
    drop(pair.slave);
    Ok((pair.master, child))
}

/// Run a local kubectl terminal until the shell exits or the task is aborted.
/// On a normal exit the temp kubeconfig is deleted here; on an abort (stop /
/// disconnect) the manager's terminal registry deletes it instead.
#[allow(clippy::too_many_arguments)]
pub async fn run_terminal(
    app: AppHandle,
    cid: Cid,
    stream_id: String,
    argv: Vec<String>,
    kubeconfig_path: PathBuf,
    login_path: String,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    mut resize_rx: mpsc::Receiver<(u16, u16)>,
) {
    let out_event = events::stream_channel(events::SHELL_OUT_PREFIX, &cid, &stream_id);
    let closed_event = events::stream_channel(events::SHELL_CLOSED_PREFIX, &cid, &stream_id);
    let reason = match terminal_pump(
        &app,
        &out_event,
        &argv,
        &kubeconfig_path,
        &login_path,
        &mut input_rx,
        &mut resize_rx,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => e.to_string(),
    };
    // Normal-exit cleanup: the temp kubeconfig must not outlive the session.
    let _ = std::fs::remove_file(&kubeconfig_path);
    let _ = app.emit(&closed_event, reason);
}

#[allow(clippy::too_many_arguments)]
async fn terminal_pump(
    app: &AppHandle,
    out_event: &str,
    argv: &[String],
    kubeconfig_path: &Path,
    login_path: &str,
    input_rx: &mut mpsc::Receiver<Vec<u8>>,
    resize_rx: &mut mpsc::Receiver<(u16, u16)>,
) -> Result<String, AppError> {
    let (master, child) = spawn_shell_pty(argv, kubeconfig_path, login_path, 80, 24)?;
    // Aborting this pump (stop / disconnect) drops the future; the guard then
    // kills the shell — the only guarantee the process ends when the task can't.
    let _child = PtyChild(child);

    // The whole point of this terminal is kubectl; say so before the prompt if
    // it isn't reachable.
    if find_kubectl(login_path).is_none() {
        let _ = app.emit(out_event, ShellOut { data: KUBECTL_MISSING_BANNER.into() });
    }

    let mut reader = master
        .try_clone_reader()
        .map_err(|e| AppError::Other(format!("could not read pty: {e}")))?;
    let mut writer = master
        .take_writer()
        .map_err(|e| AppError::Other(format!("could not take pty writer: {e}")))?;

    // portable-pty is blocking I/O; run the master reader on a dedicated thread
    // feeding an mpsc so the tokio pump below stays non-blocking.
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    loop {
        tokio::select! {
            // Shell output → frontend.
            read = out_rx.recv() => match read {
                Some(bytes) => {
                    let data = String::from_utf8_lossy(&bytes).to_string();
                    let _ = app.emit(out_event, ShellOut { data });
                }
                None => return Ok("session ended".into()),
            },
            // Frontend keystrokes → the pty.
            input = input_rx.recv() => match input {
                Some(bytes) => {
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                        return Ok("stdin closed".into());
                    }
                }
                None => return Ok("input closed".into()),
            },
            // Terminal resize → the pty.
            size = resize_rx.recv() => {
                if let Some((cols, rows)) = size {
                    let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// kubectl resolves from a PATH that contains it.
    #[test]
    fn find_kubectl_resolves_an_existing_binary() {
        let path = login_shell_path();
        assert!(!path.is_empty(), "the login shell yields a PATH");
        if let Some(k) = find_kubectl(&path) {
            assert!(std::path::Path::new(&k).is_file(), "found kubectl must exist: {k}");
        } else {
            // A dev machine without kubectl is a legit env; the assert is that a
            // PATH that *should* have it either finds it or reports missing cleanly.
            eprintln!("kubectl not on the login PATH — skipping existence check");
        }
    }

    /// kubectl is not found in an empty or garbage PATH.
    #[test]
    fn find_kubectl_misses_without_it() {
        assert_eq!(find_kubectl(""), None);
        assert_eq!(find_kubectl("/nonexistent:/also/missing"), None);
    }

    /// The default shell honours the pref override and falls back per-OS.
    #[test]
    fn default_shell_honours_override_and_platform() {
        let with_pref = default_shell_command("env TERM=xterm bash -l");
        assert!(with_pref.len() > 1, "an override is a shell snippet, not a bare binary");
        let no_pref = default_shell_command("");
        assert!(!no_pref[0].is_empty());
        #[cfg(windows)]
        assert_eq!(no_pref[0], "powershell.exe", "Windows defaults to PowerShell");
        #[cfg(not(windows))]
        assert!(!no_pref[0].is_empty(), "Unix uses $SHELL (or /bin/bash)");
    }

    /// Dropping the guard kills a still-running child — the abort path (stop /
    /// disconnect) ends the shell even though the pump can't run its cleanup.
    #[cfg(unix)]
    #[test]
    fn dropping_the_guard_kills_the_child() {
        // `sleep 100` on a pty is a child that would otherwise outlive its parent.
        let child = std::process::Command::new("sleep")
            .arg("100")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        {
            let _guard = PtyChild(Box::new(child));
        }
        // kill -0 fails once the process is gone/reaped.
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .expect("run kill -0");
        assert!(!alive.success(), "the guard killed the child (pid {pid} still alive)");
    }

    /// The temp kubeconfig round-trips and is 0600 on unix.
    #[test]
    fn temp_kubeconfig_is_written_0600_and_swept() {
        sweep_orphan_kubeconfigs();
        let path = write_temp_kubeconfig("apiVersion: v1\nkind: Config\ncurrent-context: test\n").unwrap();
        assert!(path.is_file());
        assert!(path.file_name().unwrap().to_string_lossy().starts_with(KUBECONFIG_FILE_PREFIX));
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("current-context: test"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the temp kubeconfig must be 0600");
        }
        // The sweep removes the file we just wrote.
        sweep_orphan_kubeconfigs();
        assert!(!path.exists(), "the sweep removes orphaned kubeconfigs");
    }
}
