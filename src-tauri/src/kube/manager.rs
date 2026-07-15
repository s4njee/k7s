//! [`ClientManager`] — the single owner of the active Kubernetes client and every
//! background task (watchers, pollers, log streams) spawned for the current
//! connection. Switching context or disconnecting aborts *all* of them here, so no
//! task ever outlives the connection that created it (Story 6.1).

use super::events;
use kube::Client;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

/// Mutable connection state guarded by an async RwLock.
#[derive(Default)]
struct Inner {
    /// Active client (None when disconnected).
    client: Option<Client>,
    /// Watcher + poller tasks tied to the current connection.
    tasks: Vec<JoinHandle<()>>,
    /// Live log-stream tasks keyed by stream id.
    logs: HashMap<String, JoinHandle<()>>,
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

    /// Emit the current live-stream count (watchers + log streams) to the sidebar.
    async fn emit_watch(&self) {
        let count = {
            let inner = self.inner.read().await;
            inner.watcher_count + inner.logs.len()
        };
        // Emit failures are non-fatal (the webview may be gone during shutdown).
        let _ = self.app.emit(events::WATCH_STATUS, count);
    }

    /// The AppHandle, for tasks that need to emit their own events.
    pub fn app(&self) -> AppHandle {
        self.app.clone()
    }
}
