//! [`ClientManager`] — the single owner of the active Kubernetes client and every
//! background task (watchers, pollers, log streams) spawned for the current
//! connection. Switching context or disconnecting aborts *all* of them here, so no
//! task ever outlives the connection that created it (Story 6.1).

use super::events;
use kube::Client;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;

/// A running interactive shell session (B4): its pump task and the channels used
/// to feed it stdin and terminal-resize events.
pub struct ShellSession {
    pub task: JoinHandle<()>,
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub resize_tx: mpsc::Sender<(u16, u16)>,
}

/// Frontend-facing description of an active port-forward (B6).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardDto {
    pub id: String,
    pub namespace: String,
    pub pod: String,
    pub remote_port: u16,
    pub local_port: u16,
}

/// A running port-forward: its accept-loop task plus the DTO for listing.
struct ForwardEntry {
    task: JoinHandle<()>,
    dto: ForwardDto,
}

/// Mutable connection state guarded by an async RwLock.
#[derive(Default)]
struct Inner {
    /// Active client (None when disconnected).
    client: Option<Client>,
    /// Watcher + poller tasks tied to the current connection.
    tasks: Vec<JoinHandle<()>>,
    /// Live log-stream tasks keyed by stream id.
    logs: HashMap<String, JoinHandle<()>>,
    /// Live shell sessions keyed by stream id.
    shells: HashMap<String, ShellSession>,
    /// Live port-forwards keyed by id.
    forwards: HashMap<String, ForwardEntry>,
    /// Number of resource watchers running (set on connect, 0 when disconnected).
    watcher_count: usize,
}

/// A context imported from a non-default kubeconfig file: its source path and the
/// cluster it points at (for display in the switcher).
#[derive(Clone)]
pub struct ImportedContext {
    pub path: String,
    pub cluster: String,
}

/// Owns the client + all connection-scoped tasks. Stored in Tauri managed state
/// and shared across commands via `State<Arc<ClientManager>>`.
pub struct ClientManager {
    app: AppHandle,
    inner: RwLock<Inner>,
    /// Contexts imported from extra kubeconfig files, keyed by context name.
    /// Persists across connect/reset (it's not connection-scoped) so `connect` can
    /// find which file to build a client from.
    imports: RwLock<HashMap<String, ImportedContext>>,
}

impl ClientManager {
    pub fn new(app: AppHandle) -> Self {
        ClientManager {
            app,
            inner: RwLock::new(Inner::default()),
            imports: RwLock::new(HashMap::new()),
        }
    }

    /// Record an imported context so a later `connect` builds from its source file.
    pub async fn add_import(&self, name: String, imported: ImportedContext) {
        self.imports.write().await.insert(name, imported);
    }

    /// The source file for an imported context, if it was imported.
    pub async fn import_path(&self, context: &str) -> Option<String> {
        self.imports.read().await.get(context).map(|i| i.path.clone())
    }

    /// Snapshot of all imported contexts (name → source), for building the merged
    /// switcher list.
    pub async fn imports(&self) -> HashMap<String, ImportedContext> {
        self.imports.read().await.clone()
    }

    /// Clone of the active client, if connected.
    pub async fn client(&self) -> Option<Client> {
        self.inner.read().await.client.clone()
    }

    /// Tear down the current connection: abort every watcher, poller, and log
    /// stream, and clear the client. Emits watch-status 0. Called on disconnect
    /// and before switching context.
    pub async fn reset(&self) {
        let mut inner = self.inner.write().await;
        for t in inner.tasks.drain(..) {
            t.abort();
        }
        for (_, t) in inner.logs.drain() {
            t.abort();
        }
        for (_, s) in inner.shells.drain() {
            s.task.abort();
        }
        for (_, f) in inner.forwards.drain() {
            f.task.abort();
        }
        inner.client = None;
        inner.watcher_count = 0;
        drop(inner);
        self.emit_watch().await;
    }

    /// Record a freshly established connection. Watchers are registered separately
    /// via [`push_task`]; `watcher_count` is the number of kinds being watched,
    /// used for the sidebar footer.
    pub async fn set_connected(&self, client: Client, watcher_count: usize) {
        let mut inner = self.inner.write().await;
        inner.client = Some(client);
        inner.watcher_count = watcher_count;
        drop(inner);
        self.emit_watch().await;
    }

    /// Register a connection-scoped background task so it is aborted on reset.
    pub async fn push_task(&self, handle: JoinHandle<()>) {
        self.inner.write().await.tasks.push(handle);
    }

    /// Register a log-stream task by id and bump the watch count.
    pub async fn add_log(&self, id: String, handle: JoinHandle<()>) {
        {
            let mut inner = self.inner.write().await;
            // Replace any existing stream with the same id (defensive).
            if let Some(old) = inner.logs.insert(id, handle) {
                old.abort();
            }
        }
        self.emit_watch().await;
    }

    /// Abort a log stream by id (idempotent) and drop the watch count.
    pub async fn remove_log(&self, id: &str) {
        let existed = {
            let mut inner = self.inner.write().await;
            inner.logs.remove(id).map(|h| h.abort()).is_some()
        };
        if existed {
            self.emit_watch().await;
        }
    }

    // ---- shell sessions (B4) ----

    /// Register a shell session by id.
    pub async fn add_shell(&self, id: String, session: ShellSession) {
        {
            let mut inner = self.inner.write().await;
            if let Some(old) = inner.shells.insert(id, session) {
                old.task.abort();
            }
        }
        self.emit_watch().await;
    }

    /// Send stdin bytes to a shell session (no-op if the id is unknown).
    pub async fn shell_input(&self, id: &str, data: Vec<u8>) {
        let tx = self.inner.read().await.shells.get(id).map(|s| s.input_tx.clone());
        if let Some(tx) = tx {
            let _ = tx.send(data).await;
        }
    }

    /// Send a terminal resize to a shell session.
    pub async fn shell_resize(&self, id: &str, cols: u16, rows: u16) {
        let tx = self.inner.read().await.shells.get(id).map(|s| s.resize_tx.clone());
        if let Some(tx) = tx {
            let _ = tx.send((cols, rows)).await;
        }
    }

    /// Abort a shell session by id (idempotent).
    pub async fn remove_shell(&self, id: &str) {
        let existed = {
            let mut inner = self.inner.write().await;
            inner.shells.remove(id).map(|s| s.task.abort()).is_some()
        };
        if existed {
            self.emit_watch().await;
        }
    }

    // ---- port-forwards (B6) ----

    /// Register a port-forward.
    pub async fn add_forward(&self, dto: ForwardDto, task: JoinHandle<()>) {
        {
            let mut inner = self.inner.write().await;
            inner.forwards.insert(dto.id.clone(), ForwardEntry { task, dto });
        }
        self.emit_watch().await;
    }

    /// Abort a port-forward by id (idempotent).
    pub async fn remove_forward(&self, id: &str) {
        let existed = {
            let mut inner = self.inner.write().await;
            inner.forwards.remove(id).map(|f| f.task.abort()).is_some()
        };
        if existed {
            self.emit_watch().await;
        }
    }

    /// Snapshot of active port-forwards for the UI list.
    pub async fn list_forwards(&self) -> Vec<ForwardDto> {
        self.inner.read().await.forwards.values().map(|f| f.dto.clone()).collect()
    }

    /// Emit the current live-stream count (watchers + logs + shells + forwards).
    async fn emit_watch(&self) {
        let count = {
            let inner = self.inner.read().await;
            inner.watcher_count + inner.logs.len() + inner.shells.len() + inner.forwards.len()
        };
        // Emit failures are non-fatal (the webview may be gone during shutdown).
        let _ = self.app.emit(events::WATCH_STATUS, count);
    }

    /// The AppHandle, for tasks that need to emit their own events.
    pub fn app(&self) -> AppHandle {
        self.app.clone()
    }
}
