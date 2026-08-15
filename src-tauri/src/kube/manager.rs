//! [`ClientManager`] — the owner of every Kubernetes client and background task
//! (watchers, pollers, log streams, shells, forwards), keyed by cluster (B76).
//! Multiple clusters connect side-by-side, each with its own lifecycle:
//! `disconnect(cid)` tears down exactly one cluster's tasks and streams, never
//! anyone else's, and `connect` to an already-live cid reuses it (the O(instant)
//! switch) rather than rebuilding.
//!
//! Streams and forwards are keyed by a *globally-unique* stream id (STREAM_SEQ)
//! and tagged with their cluster, so stop-commands take only the id: after a
//! cluster switch the frontend's active cid can differ from the cluster a stream
//! belongs to, and a stop must still find it. `disconnect(cid)` filters the
//! global maps by the tag.

use super::client::ClusterInfo;
use super::discovery::CustomKind;
use super::metrics::ClusterStatusPayload;
use super::{dto::Row, events, ResourceUpdate, Cid};
use kube::Client;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Runtime};
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
    /// The cluster this forward belongs to (B77) — the strip badges it so a
    /// forward opened on one cluster is never ambiguous while viewing another.
    pub cid: String,
    pub namespace: String,
    /// The pod traffic actually reaches — for a Service forward, the one that was
    /// selected (B16).
    pub pod: String,
    /// Set when this forward was started from a Service: the service's name, which
    /// is what the user asked for and what the strip shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// The port on the pod. For a Service forward this is the resolved targetPort,
    /// which may differ from the service port the user typed.
    pub remote_port: u16,
    /// The port as the user asked for it — the Service's own port (B16). Only set
    /// for Service forwards, and only when it differs from `remote_port`; the
    /// strip shows this, since the resolved targetPort is a port the Service
    /// doesn't publish and nobody asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_port: Option<u16>,
    pub local_port: u16,
    /// Last per-connection failure, if any (B16). The listener stays up, so this
    /// is how a forward whose pod died surfaces instead of silently timing out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A running port-forward: its accept-loop task plus the DTO for listing.
struct ForwardEntry {
    cid: Cid,
    task: JoinHandle<()>,
    dto: ForwardDto,
}

/// Per-cluster connection state (B76).
#[derive(Default)]
struct ClusterState {
    /// Active client (None when disconnected).
    client: Option<Client>,
    /// Watcher + poller tasks for this cluster.
    tasks: Vec<JoinHandle<()>>,
    /// Number of resource watchers running (set on connect, 0 when disconnected).
    watcher_count: usize,
    /// CRD-backed kinds discovered on connect, keyed by kind id (B15). Populated
    /// on connect so commands can resolve a custom id back to its ApiResource.
    custom_kinds: HashMap<String, CustomKind>,
    /// Lazily-started watchers for custom kinds, keyed by kind id (B15). Held
    /// separately from `tasks` because these are aborted individually when the
    /// user navigates away, not only on disconnect.
    custom_watchers: HashMap<String, JoinHandle<()>>,
    /// Node-exporter scrapers, keyed by node name (B27). Same lifetime rule as
    /// custom watchers: one runs only while its node's Metrics tab is open.
    node_scrapers: HashMap<String, JoinHandle<()>>,
    /// Cached connect result (server, version) — re-connecting to a live cluster
    /// returns this instead of rebuilding.
    info: Option<ClusterInfo>,
    /// Last row snapshot per kind, so a re-switch renders instantly from the
    /// retained backend state (B76).
    last_rows: HashMap<String, Vec<Row>>,
    /// Last cluster status, for the same reason.
    last_status: Option<ClusterStatusPayload>,
    /// Last discovered custom kinds, for the same reason.
    last_kinds: Vec<CustomKind>,
}

/// A context imported from a non-default kubeconfig file: its source path and the
/// cluster it points at (for display in the switcher).
#[derive(Clone)]
pub struct ImportedContext {
    pub path: String,
    pub cluster: String,
}

/// Owns every cluster's client + connection-scoped tasks. Stored in Tauri managed
/// state and shared across commands via `State<Arc<ClientManager>>`.
///
/// Generic over the Tauri runtime so the lifecycle can be unit-tested against
/// `tauri::test::mock_app()` (`ClientManager<MockRuntime>`) while the app uses
/// the default Wry runtime.
pub struct ClientManager<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    /// Per-cluster connection state, keyed by cid (B76).
    clusters: RwLock<HashMap<Cid, ClusterState>>,
    /// Live log streams keyed by stream id, tagged with their cluster. Ids are
    /// globally unique (STREAM_SEQ), so lookups are by id; `disconnect` filters
    /// by the tag.
    logs: RwLock<HashMap<String, (Cid, JoinHandle<()>)>>,
    /// Live shell sessions keyed by stream id, tagged with their cluster.
    shells: RwLock<HashMap<String, (Cid, ShellSession)>>,
    /// Live port-forwards keyed by id, tagged with their cluster.
    forwards: RwLock<HashMap<String, ForwardEntry>>,
    /// Contexts imported from extra kubeconfig files, keyed by context name.
    /// Persists across connect/disconnect (it's not cluster-scoped) so `connect`
    /// can find which file to build a client from.
    imports: RwLock<HashMap<String, ImportedContext>>,
}

impl<R: Runtime> ClientManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        ClientManager {
            app,
            clusters: RwLock::new(HashMap::new()),
            logs: RwLock::new(HashMap::new()),
            shells: RwLock::new(HashMap::new()),
            forwards: RwLock::new(HashMap::new()),
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

    // ---- per-cluster lifecycle (B76) ----

    /// Is a live connection established for `cid`?
    pub async fn is_connected(&self, cid: &Cid) -> bool {
        self.clusters.read().await.contains_key(cid)
    }

    /// The cached connect result for a live connection.
    pub async fn info(&self, cid: &Cid) -> Option<ClusterInfo> {
        self.clusters.read().await.get(cid).and_then(|c| c.info.clone())
    }

    /// Clone of a cluster's active client, if connected.
    pub async fn client(&self, cid: &Cid) -> Option<Client> {
        self.clusters.read().await.get(cid).and_then(|c| c.client.clone())
    }

    /// Record a freshly established connection. Watchers are registered separately
    /// via [`push_task`]; `watcher_count` is the number of kinds being watched,
    /// used for the sidebar footer.
    pub async fn set_connected(
        &self,
        cid: Cid,
        client: Client,
        info: ClusterInfo,
        watcher_count: usize,
    ) {
        {
            let mut clusters = self.clusters.write().await;
            let state = clusters.entry(cid.clone()).or_default();
            state.client = Some(client);
            state.info = Some(info);
            state.watcher_count = watcher_count;
        }
        self.emit_watch(&cid).await;
    }

    /// Tear down one cluster: abort its watchers, pollers, and the streams and
    /// forwards tagged with it, and drop its state. Other clusters are untouched.
    pub async fn disconnect(&self, cid: &Cid) {
        if let Some(mut state) = self.clusters.write().await.remove(cid) {
            for t in state.tasks.drain(..) {
                t.abort();
            }
            for (_, t) in state.custom_watchers.drain() {
                t.abort();
            }
            for (_, t) in state.node_scrapers.drain() {
                t.abort();
            }
        }
        // Streams and forwards tagged with this cid die with it. Logs and shells
        // have different value types, so each map is drained separately.
        {
            let mut logs = self.logs.write().await;
            let dead: Vec<String> = logs
                .iter()
                .filter(|(_, (c, _))| c == cid)
                .map(|(id, _)| id.clone())
                .collect();
            for id in dead {
                if let Some((_, h)) = logs.remove(&id) {
                    h.abort();
                }
            }
        }
        {
            let mut shells = self.shells.write().await;
            let dead: Vec<String> = shells
                .iter()
                .filter(|(_, (c, _))| c == cid)
                .map(|(id, _)| id.clone())
                .collect();
            for id in dead {
                if let Some((_, s)) = shells.remove(&id) {
                    s.task.abort();
                }
            }
        }
        let dead: Vec<String> = self
            .forwards
            .write()
            .await
            .iter()
            .filter(|(_, f)| &f.cid == cid)
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead {
            if let Some(f) = self.forwards.write().await.remove(&id) {
                f.task.abort();
            }
        }
        self.emit_watch(cid).await;
        self.emit_forwards(cid).await;
    }

    /// Re-emit the cached snapshots (rows, status, kinds, watch count, forwards)
    /// for a live connection — the instant-switch path: the frontend resubscribes
    /// to `{event}:{cid}` and the retained backend state repopulates the store.
    pub async fn refresh(&self, cid: &Cid) {
        let (rows, status, kinds) = {
            let clusters = self.clusters.read().await;
            match clusters.get(cid) {
                Some(s) => (s.last_rows.clone(), s.last_status.clone(), s.last_kinds.clone()),
                None => return,
            }
        };
        for (kind, rows) in rows {
            self.emit_rows(cid, kind, rows).await;
        }
        if let Some(status) = status {
            self.emit_status(cid, status).await;
        }
        self.emit_kinds(cid, kinds).await;
        self.emit_watch(cid).await;
        self.emit_forwards(cid).await;
    }

    /// Register a connection-scoped background task so it is aborted on disconnect.
    pub async fn push_task(&self, cid: Cid, handle: JoinHandle<()>) {
        self.clusters.write().await.entry(cid).or_default().tasks.push(handle);
    }

    // ---- sticky snapshot emission (cached for refresh) ----

    /// Emit a row snapshot for a kind on `resource-update:{cid}`, keeping the
    /// last one per kind so a re-switch can replay it. Watchers call this.
    pub async fn emit_rows(&self, cid: &Cid, kind: String, rows: Vec<Row>) {
        {
            let mut clusters = self.clusters.write().await;
            if let Some(s) = clusters.get_mut(cid) {
                s.last_rows.insert(kind.clone(), rows.clone());
            }
        }
        let _ = self
            .app
            .emit(&events::channel(events::RESOURCE_UPDATE, cid), ResourceUpdate { kind, rows });
    }

    /// Emit a cluster-status payload on `cluster-status:{cid}`, caching it.
    pub(crate) async fn emit_status(&self, cid: &Cid, payload: ClusterStatusPayload) {
        {
            let mut clusters = self.clusters.write().await;
            if let Some(s) = clusters.get_mut(cid) {
                s.last_status = Some(payload.clone());
            }
        }
        let _ = self.app.emit(&events::channel(events::CLUSTER_STATUS, cid), payload);
    }

    /// Emit discovered custom kinds on `custom-kinds:{cid}`, caching them.
    pub async fn emit_kinds(&self, cid: &Cid, kinds: Vec<CustomKind>) {
        {
            let mut clusters = self.clusters.write().await;
            if let Some(s) = clusters.get_mut(cid) {
                s.last_kinds = kinds.clone();
            }
        }
        let _ = self.app.emit(&events::channel(events::CUSTOM_KINDS, cid), kinds);
    }

    // ---- log streams (id-based, cid-tagged) ----

    /// Register a log-stream task by id and bump the watch count.
    pub async fn add_log(&self, cid: Cid, id: String, handle: JoinHandle<()>) {
        {
            let mut logs = self.logs.write().await;
            // Replace any existing stream with the same id (defensive).
            if let Some((_, old)) = logs.insert(id, (cid.clone(), handle)) {
                old.abort();
            }
        }
        self.emit_watch(&cid).await;
    }

    /// Abort a log stream by id (idempotent) and drop the watch count.
    pub async fn remove_log(&self, id: &str) {
        let cid = {
            let mut logs = self.logs.write().await;
            logs.remove(id).map(|(c, h)| {
                h.abort();
                c
            })
        };
        if let Some(cid) = cid {
            self.emit_watch(&cid).await;
        }
    }

    // ---- shell sessions (B4) ----

    /// Register a shell session by id.
    pub async fn add_shell(&self, cid: Cid, id: String, session: ShellSession) {
        {
            let mut shells = self.shells.write().await;
            if let Some((_, old)) = shells.insert(id, (cid.clone(), session)) {
                old.task.abort();
            }
        }
        self.emit_watch(&cid).await;
    }

    /// Send stdin bytes to a shell session (no-op if the id is unknown).
    pub async fn shell_input(&self, id: &str, data: Vec<u8>) {
        let tx = self.shells.read().await.get(id).map(|(_, s)| s.input_tx.clone());
        if let Some(tx) = tx {
            let _ = tx.send(data).await;
        }
    }

    /// Send a terminal resize to a shell session.
    pub async fn shell_resize(&self, id: &str, cols: u16, rows: u16) {
        let tx = self.shells.read().await.get(id).map(|(_, s)| s.resize_tx.clone());
        if let Some(tx) = tx {
            let _ = tx.send((cols, rows)).await;
        }
    }

    /// Abort a shell session by id (idempotent).
    pub async fn remove_shell(&self, id: &str) {
        let cid = {
            let mut shells = self.shells.write().await;
            shells.remove(id).map(|(c, s)| {
                s.task.abort();
                c
            })
        };
        if let Some(cid) = cid {
            self.emit_watch(&cid).await;
        }
    }

    // ---- port-forwards (B6) ----

    /// Register a port-forward.
    pub async fn add_forward(&self, cid: Cid, dto: ForwardDto, task: JoinHandle<()>) {
        {
            let mut forwards = self.forwards.write().await;
            forwards.insert(dto.id.clone(), ForwardEntry { cid: cid.clone(), task, dto });
        }
        self.emit_watch(&cid).await;
        self.emit_forwards(&cid).await;
    }

    /// Abort a port-forward by id (idempotent).
    pub async fn remove_forward(&self, id: &str) {
        let cid = {
            let mut forwards = self.forwards.write().await;
            forwards.remove(id).map(|f| {
                f.task.abort();
                f.cid
            })
        };
        if let Some(cid) = cid {
            self.emit_watch(&cid).await;
            self.emit_forwards(&cid).await;
        }
    }

    /// Record a per-connection failure against a forward and push it to the UI
    /// (B16). The forward keeps running: its listener is still bound, and the pod
    /// may well come back.
    pub async fn set_forward_error(&self, id: &str, error: String) {
        let cid = {
            let mut forwards = self.forwards.write().await;
            match forwards.get_mut(id) {
                Some(f) => {
                    f.dto.error = Some(error);
                    Some(f.cid.clone())
                }
                None => None,
            }
        };
        if let Some(cid) = cid {
            self.emit_forwards(&cid).await;
        }
    }

    /// Snapshot of one cluster's active port-forwards for the UI list.
    pub async fn list_forwards(&self, cid: &Cid) -> Vec<ForwardDto> {
        self.forwards
            .read()
            .await
            .values()
            .filter(|f| &f.cid == cid)
            .map(|f| f.dto.clone())
            .collect()
    }

    /// Push one cluster's current forwards to the UI.
    async fn emit_forwards(&self, cid: &Cid) {
        let list = self.list_forwards(cid).await;
        let _ = self.app.emit(&events::channel(events::FORWARDS_UPDATE, cid), list);
    }

    // ---- custom (CRD-backed) kinds (B15) ----

    /// Record the kinds discovered for this connection.
    pub async fn set_custom_kinds(&self, cid: Cid, kinds: Vec<CustomKind>) {
        let mut clusters = self.clusters.write().await;
        if let Some(s) = clusters.get_mut(&cid) {
            s.custom_kinds = kinds.into_iter().map(|k| (k.id.clone(), k)).collect();
        }
    }

    /// Look up a discovered custom kind by id (e.g. "argoproj.io/applications").
    pub async fn custom_kind(&self, cid: &Cid, id: &str) -> Option<CustomKind> {
        self.clusters.read().await.get(cid).and_then(|s| s.custom_kinds.get(id).cloned())
    }

    /// Look up a discovered custom kind by its Kubernetes Kind + group (B36:
    /// create-from-YAML resolves a manifest's kind/group to the resource).
    pub async fn custom_kind_by_name(&self, cid: &Cid, group: &str, kind: &str) -> Option<CustomKind> {
        self.clusters
            .read()
            .await
            .get(cid)
            .and_then(|s| s.custom_kinds.values().find(|k| k.group == group && k.kind == kind).cloned())
    }

    /// Register a lazily-started watcher for a custom kind. Replaces (and aborts)
    /// any existing watcher for the same kind, so double-registration is safe.
    pub async fn add_custom_watcher(&self, cid: Cid, id: String, handle: JoinHandle<()>) {
        {
            let mut clusters = self.clusters.write().await;
            if let Some(s) = clusters.get_mut(&cid) {
                if let Some(old) = s.custom_watchers.insert(id, handle) {
                    old.abort();
                }
            }
        }
        self.emit_watch(&cid).await;
    }

    /// True when a watcher for this custom kind is already running.
    pub async fn has_custom_watcher(&self, cid: &Cid, id: &str) -> bool {
        self.clusters.read().await.get(cid).is_some_and(|s| s.custom_watchers.contains_key(id))
    }

    /// Abort a custom kind's watcher (idempotent), e.g. when the user navigates away.
    pub async fn remove_custom_watcher(&self, cid: &Cid, id: &str) {
        let existed = {
            let mut clusters = self.clusters.write().await;
            match clusters.get_mut(cid) {
                Some(s) => s.custom_watchers.remove(id).map(|h| h.abort()).is_some(),
                None => false,
            }
        };
        if existed {
            self.emit_watch(cid).await;
        }
    }

    /// Register a node-exporter scraper (B27). Replaces any existing one for the
    /// same node, so opening the tab twice can't leave a forward behind.
    pub async fn add_node_scraper(&self, cid: Cid, node: String, handle: JoinHandle<()>) {
        {
            let mut clusters = self.clusters.write().await;
            if let Some(s) = clusters.get_mut(&cid) {
                if let Some(old) = s.node_scrapers.insert(node, handle) {
                    old.abort();
                }
            }
        }
        self.emit_watch(&cid).await;
    }

    /// True when this node is already being scraped.
    pub async fn has_node_scraper(&self, cid: &Cid, node: &str) -> bool {
        self.clusters.read().await.get(cid).is_some_and(|s| s.node_scrapers.contains_key(node))
    }

    /// Stop scraping a node (idempotent), dropping its port-forward with it.
    pub async fn remove_node_scraper(&self, cid: &Cid, node: &str) {
        let existed = {
            let mut clusters = self.clusters.write().await;
            match clusters.get_mut(cid) {
                Some(s) => s.node_scrapers.remove(node).map(|h| h.abort()).is_some(),
                None => false,
            }
        };
        if existed {
            self.emit_watch(cid).await;
        }
    }

    /// Emit the current live-stream count for one cluster (watchers + logs +
    /// shells + forwards). Custom kinds count only while their watcher is open.
    async fn emit_watch(&self, cid: &Cid) {
        let count = {
            let clusters = self.clusters.read().await;
            let logs = self.logs.read().await;
            let shells = self.shells.read().await;
            let forwards = self.forwards.read().await;
            let base = clusters
                .get(cid)
                .map(|s| s.watcher_count + s.custom_watchers.len() + s.node_scrapers.len())
                .unwrap_or(0);
            let streams = logs.values().filter(|(c, _)| c == cid).count()
                + shells.values().filter(|(c, _)| c == cid).count()
                + forwards.values().filter(|f| &f.cid == cid).count();
            base + streams
        };
        // Emit failures are non-fatal (the webview may be gone during shutdown).
        let _ = self.app.emit(&events::channel(events::WATCH_STATUS, cid), count);
    }

    /// The AppHandle, for tasks that need to emit their own events.
    pub fn app(&self) -> AppHandle<R> {
        self.app.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A manager backed by Tauri's mock runtime — enough for lifecycle tests:
    /// emit is a no-op (no listeners), and the maps are observable. Cids are
    /// established via [`push_task`] (which creates the cluster entry) so no real
    /// `kube::Client` is needed.
    fn manager() -> ClientManager<tauri::test::MockRuntime> {
        ClientManager::new(tauri::test::mock_app().handle().clone())
    }

    fn forward(id: &str) -> ForwardDto {
        ForwardDto {
            id: id.into(),
            cid: "test".into(),
            namespace: "default".into(),
            pod: "p".into(),
            service: None,
            remote_port: 80,
            service_port: None,
            local_port: 8080,
            error: None,
        }
    }

    /// Two clusters coexist; disconnecting one leaves the other's tasks alive.
    #[tokio::test]
    async fn two_clusters_are_isolated() {
        let mgr = manager();
        mgr.push_task("a".into(), tokio::spawn(async {})).await;
        mgr.push_task("b".into(), tokio::spawn(async {})).await;
        assert!(mgr.is_connected(&"a".to_string()).await);
        assert!(mgr.is_connected(&"b".to_string()).await);

        mgr.disconnect(&"a".to_string()).await;

        assert!(!mgr.is_connected(&"a".to_string()).await, "a torn down");
        assert!(mgr.is_connected(&"b".to_string()).await, "b untouched");
        assert_eq!(
            mgr.clusters.read().await.get(&"b".to_string()).unwrap().tasks.len(),
            1,
            "b's task survived a's disconnect"
        );
        assert!(mgr.clusters.read().await.get("a").is_none());
    }

    /// Streams and forwards die with their own cluster only.
    #[tokio::test]
    async fn streams_die_with_their_cluster() {
        let mgr = manager();
        mgr.add_log("a".into(), "log-a".into(), tokio::spawn(async {})).await;
        mgr.add_log("b".into(), "log-b".into(), tokio::spawn(async {})).await;
        mgr.add_forward("a".into(), forward("pf-a"), tokio::spawn(async {})).await;
        mgr.add_forward("b".into(), forward("pf-b"), tokio::spawn(async {})).await;

        mgr.disconnect(&"a".to_string()).await;

        assert!(mgr.logs.read().await.get("log-a").is_none(), "a's log gone");
        assert!(mgr.logs.read().await.get("log-b").is_some(), "b's log kept");
        assert!(mgr.forwards.read().await.get("pf-a").is_none(), "a's forward gone");
        assert!(mgr.forwards.read().await.get("pf-b").is_some(), "b's forward kept");
        assert_eq!(mgr.list_forwards(&"b".to_string()).await.len(), 1);
        assert_eq!(mgr.list_forwards(&"a".to_string()).await.len(), 0);
    }

    /// Cached snapshots are kept per kind and replayed by refresh (the
    /// instant-switch path).
    #[tokio::test]
    async fn refresh_replays_cached_snapshots() {
        let mgr = manager();
        mgr.push_task("a".into(), tokio::spawn(async {})).await;
        mgr.emit_rows(&"a".to_string(), "pods".into(), vec![]).await;
        mgr.emit_rows(&"a".to_string(), "nodes".into(), vec![]).await;

        mgr.refresh(&"a".to_string()).await;

        let clusters = mgr.clusters.read().await;
        let cached = clusters.get("a").unwrap();
        assert!(cached.last_rows.contains_key("pods"));
        assert!(cached.last_rows.contains_key("nodes"));
    }
}
