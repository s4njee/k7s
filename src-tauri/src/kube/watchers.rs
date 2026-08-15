//! Per-kind watchers. Each kind gets a task that drives a `kube` reflector (so a
//! local store stays current, including deletes) and emits a *full row snapshot*
//! for that kind, debounced to at most once per [`DEBOUNCE`]. Snapshots are
//! idempotent, which avoids any delta-reconciliation bugs in the UI.
//!
//! A watcher that fails (e.g. RBAC forbids a kind) logs and — thanks to
//! `default_backoff` — keeps retrying without affecting the other kinds.
//!
//! Each watcher also carries a post-processor applied to the snapshot before it
//! is emitted. Most kinds use [`identity`] (the frontend sorts); the Events feed
//! uses it to order and cap a stream that can otherwise run to thousands of rows.

use super::discovery::{CustomKind, PrinterColumn};
use super::manager::WatcherState;
use super::{dto::Row, helm, mappers, Cid, ClientManager, ResourceKind};
use crate::error::{AppError, ErrorCode, ErrorEnvelope};
use futures::stream::BoxStream;
use futures::StreamExt;
use k8s_openapi::api::admissionregistration::v1::{
    MutatingWebhookConfiguration, ValidatingWebhookConfiguration,
};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Event, LimitRange, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod,
    ResourceQuota, Secret, Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::{Ingress, IngressClass, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::api::storage::v1::StorageClass;
use kube::core::{ApiResource, DynamicObject};
use kube::runtime::reflector::Lookup;
use kube::runtime::{reflector, watcher, WatchStreamExt};
use kube::{Api, Client, Resource};
use serde::de::DeserializeOwned;
use std::fmt::Debug;
use std::hash::Hash;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Runtime;
use tokio::time::{interval, Duration, MissedTickBehavior};

/// Maximum snapshot emit rate per kind (coalesces bursts of watch events).
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Emit a full-snapshot resync every N debounce windows (B78) — the escape hatch
/// that corrects any drift a missed watch event could cause between deltas.
const RESYNC_EVERY: u32 = 100;

/// Cap on the cluster-wide events feed (B14) — busy clusters produce thousands.
const EVENTS_CAP: usize = 500;

/// Default snapshot post-processing: emit rows as the reflector holds them.
fn identity(rows: Vec<Row>) -> Vec<Row> {
    rows
}

/// Events feed ordering: Warnings first, newest first, capped.
fn events_order(rows: Vec<Row>) -> Vec<Row> {
    mappers::sort_events(rows, EVENTS_CAP)
}

/// Start watchers for every kind and register their tasks with the manager so
/// they are aborted on disconnect/context-switch. Returns the number started.
pub async fn spawn_all<R: Runtime>(mgr: Arc<ClientManager<R>>, cid: Cid, client: Client) -> usize {
    // Each line pairs a typed resource with its mapper (the column contract) and
    // a snapshot post-processor (ordering/capping; identity for most kinds).
    spawn::<_, Pod>(&mgr, &cid, &client, ResourceKind::Pods, mappers::map_pod, identity).await;
    spawn::<_, Deployment>(&mgr, &cid, &client, ResourceKind::Deployments, mappers::map_deployment, identity).await;
    spawn::<_, ReplicaSet>(&mgr, &cid, &client, ResourceKind::Replicasets, mappers::map_replicaset, identity).await;
    spawn::<_, StatefulSet>(&mgr, &cid, &client, ResourceKind::Statefulsets, mappers::map_statefulset, identity).await;
    spawn::<_, DaemonSet>(&mgr, &cid, &client, ResourceKind::Daemonsets, mappers::map_daemonset, identity).await;
    spawn::<_, Job>(&mgr, &cid, &client, ResourceKind::Jobs, mappers::map_job, identity).await;
    spawn::<_, CronJob>(&mgr, &cid, &client, ResourceKind::Cronjobs, mappers::map_cronjob, identity).await;
    // Autoscaling + disruption budgets (B80/B61).
    spawn::<_, HorizontalPodAutoscaler>(&mgr, &cid, &client, ResourceKind::Horizontalpodautoscalers, mappers::map_hpa, identity).await;
    spawn::<_, PodDisruptionBudget>(&mgr, &cid, &client, ResourceKind::Poddisruptionbudgets, mappers::map_pdb, identity).await;
    spawn::<_, Service>(&mgr, &cid, &client, ResourceKind::Services, mappers::map_service, identity).await;
    spawn::<_, Ingress>(&mgr, &cid, &client, ResourceKind::Ingresses, mappers::map_ingress, identity).await;
    spawn::<_, IngressClass>(&mgr, &cid, &client, ResourceKind::Ingressclasses, mappers::map_ingressclass, identity).await;
    spawn::<_, NetworkPolicy>(&mgr, &cid, &client, ResourceKind::Networkpolicies, mappers::map_networkpolicy, identity).await;
    spawn::<_, ConfigMap>(&mgr, &cid, &client, ResourceKind::Configmaps, mappers::map_configmap, identity).await;
    spawn::<_, Secret>(&mgr, &cid, &client, ResourceKind::Secrets, mappers::map_secret, identity).await;
    spawn::<_, ResourceQuota>(&mgr, &cid, &client, ResourceKind::Resourcequotas, mappers::map_resourcequota, identity).await;
    spawn::<_, LimitRange>(&mgr, &cid, &client, ResourceKind::Limitranges, mappers::map_limitrange, identity).await;
    spawn::<_, ServiceAccount>(&mgr, &cid, &client, ResourceKind::Serviceaccounts, mappers::map_serviceaccount, identity).await;
    // RBAC (B49).
    spawn::<_, Role>(&mgr, &cid, &client, ResourceKind::Roles, mappers::map_role, identity).await;
    spawn::<_, ClusterRole>(&mgr, &cid, &client, ResourceKind::Clusterroles, mappers::map_clusterrole, identity).await;
    spawn::<_, RoleBinding>(&mgr, &cid, &client, ResourceKind::Rolebindings, mappers::map_rolebinding, identity).await;
    spawn::<_, ClusterRoleBinding>(&mgr, &cid, &client, ResourceKind::Clusterrolebindings, mappers::map_clusterrolebinding, identity).await;
    spawn::<_, PersistentVolumeClaim>(&mgr, &cid, &client, ResourceKind::Persistentvolumeclaims, mappers::map_pvc, identity).await;
    spawn::<_, PersistentVolume>(&mgr, &cid, &client, ResourceKind::Persistentvolumes, mappers::map_pv, identity).await;
    spawn::<_, StorageClass>(&mgr, &cid, &client, ResourceKind::Storageclasses, mappers::map_storageclass, identity).await;
    spawn::<_, Node>(&mgr, &cid, &client, ResourceKind::Nodes, mappers::map_node, identity).await;
    spawn::<_, Namespace>(&mgr, &cid, &client, ResourceKind::Namespaces, mappers::map_namespace, identity).await;
    // Admission webhook configurations (B80), cluster-scoped.
    spawn::<_, MutatingWebhookConfiguration>(&mgr, &cid, &client, ResourceKind::Mutatingwebhookconfigurations, mappers::map_mutatingwebhookconfiguration, identity).await;
    spawn::<_, ValidatingWebhookConfiguration>(&mgr, &cid, &client, ResourceKind::Validatingwebhookconfigurations, mappers::map_validatingwebhookconfiguration, identity).await;
    // Cluster-wide events feed: ordered Warnings-first/newest and capped (B14).
    spawn::<_, Event>(&mgr, &cid, &client, ResourceKind::Events, mappers::map_event, events_order).await;
    // Helm releases, decoded from their Secrets (B26).
    let handle = tokio::spawn({
        let mgr = mgr.clone();
        let cid = cid.clone();
        let client = client.clone();
        async move { run_helm_watcher(mgr, cid, client).await }
    });
    mgr.push_task(cid, handle).await;
    // Spawned kinds + 1 for the overview pseudo-kind (the sidebar footer counts streams).
    32
}

/// Spawn one watcher task and register it with the manager.
async fn spawn<R: Runtime, K>(
    mgr: &Arc<ClientManager<R>>,
    cid: &Cid,
    client: &Client,
    kind: ResourceKind,
    map_fn: fn(&K) -> Row,
    post_fn: fn(Vec<Row>) -> Vec<Row>,
) where
    // All of these are concrete typed resources whose DynamicType (for both the
    // Resource and Lookup traits) is the unit type; pinning it to () disambiguates
    // the two associated types and satisfies the Default/Eq/Hash/Clone/Send bounds
    // required by Api::all, watcher(), and reflector::store().
    K: Resource<DynamicType = ()>
        + Lookup<DynamicType = ()>
        + Clone
        + DeserializeOwned
        + Debug
        + Send
        + Sync
        + 'static,
{
    let mgr_task = mgr.clone();
    let cid_task = cid.clone();
    let client_task = client.clone();
    let handle = tokio::spawn(async move {
        run_watcher::<R, K>(mgr_task, cid_task, client_task, kind, map_fn, post_fn).await;
    });
    mgr.push_task(cid.clone(), handle).await;
}

/// Drive a reflector for `K` and emit debounced, post-processed snapshots for `kind`.
async fn run_watcher<R: Runtime, K>(
    mgr: Arc<ClientManager<R>>,
    cid: Cid,
    client: Client,
    kind: ResourceKind,
    map_fn: fn(&K) -> Row,
    post_fn: fn(Vec<Row>) -> Vec<Row>,
) where
    // Pin both DynamicType assoc types to () (see spawn()'s bound for why).
    K: Resource<DynamicType = ()>
        + Lookup<DynamicType = ()>
        + Clone
        + DeserializeOwned
        + Debug
        + Send
        + Sync
        + 'static,
{
    // Cluster-wide watch for this kind.
    let api: Api<K> = Api::all(client);
    let (reader, writer) = reflector::store::<K>();

    // reflector() writes every event into the store and passes it through; the
    // store therefore reflects adds *and* deletes. default_backoff() retries on
    // transient/permission errors instead of terminating the stream.
    let stream = reflector(writer, watcher(api, watcher::Config::default()))
        .default_backoff()
        .boxed();

    pump(mgr, cid, reader, stream, kind.id().to_string(), super::mappers::uid_of, |o| Some(map_fn(o)), post_fn).await;
}

/// Ordering/reduction for the Helm feed: newest revision per release (B26).
fn helm_latest(rows: Vec<Row>) -> Vec<Row> {
    helm::latest_only(rows)
}

/// Watch Helm releases (B26).
///
/// A second Secrets watch, field-selected to Helm's release type — the API server
/// does the filtering, so this doesn't re-ship every Secret in the cluster just to
/// throw most of them away. It's separate from the Secrets kind on purpose: that
/// one redacts and lists Secrets as Secrets, while this one decodes them into
/// something else entirely.
async fn run_helm_watcher<R: Runtime>(mgr: Arc<ClientManager<R>>, cid: Cid, client: Client) {
    let api: Api<Secret> = Api::all(client);
    let (reader, writer) = reflector::store::<Secret>();
    let cfg = watcher::Config::default().fields(&format!("type={}", helm::RELEASE_SECRET_TYPE));
    let stream = reflector(writer, watcher(api, cfg)).default_backoff().boxed();

    pump(
        mgr,
        cid,
        reader,
        stream,
        ResourceKind::Helm.id().to_string(),
        super::mappers::uid_of,
        helm::map_release,
        helm_latest,
    )
    .await;
}

/// Spawn a watcher for a CRD-backed kind (B15), registered so it can be aborted
/// on its own when the user navigates away. Unlike the built-ins these start
/// lazily: freya alone has 44 CRDs, and watching them all on connect would open
/// dozens of pointless streams.
pub async fn spawn_custom<R: Runtime>(mgr: &Arc<ClientManager<R>>, cid: &Cid, client: Client, kind: &CustomKind) {
    let mgr_task = mgr.clone();
    let cid_task = cid.clone();
    let id = kind.id.clone();
    let ar = kind.api_resource();
    let namespaced = kind.namespaced;
    // Printer columns are the CRD's own column declaration (B30); cloning them
    // into the watcher lets every row evaluate them against its object.
    let columns = kind.printer_columns.clone();
    let handle = tokio::spawn(async move {
        run_custom_watcher(mgr_task, cid_task, client, id, ar, namespaced, columns).await;
    });
    mgr.add_custom_watcher(cid.clone(), kind.id.clone(), handle).await;
}

/// Drive a `DynamicObject` reflector for one CRD-backed kind.
async fn run_custom_watcher<R: Runtime>(
    mgr: Arc<ClientManager<R>>,
    cid: Cid,
    client: Client,
    id: String,
    ar: ApiResource,
    namespaced: bool,
    columns: Vec<PrinterColumn>,
) {
    let api: Api<DynamicObject> = Api::all_with(client, &ar);

    // DynamicObject's DynamicType is the ApiResource itself (it's what tells the
    // store how to identify objects), so the store is built from `ar` rather than
    // via reflector::store()'s Default-based path used for typed kinds.
    let writer = reflector::store::Writer::<DynamicObject>::new(ar.clone());
    let reader = writer.as_reader();

    let stream = reflector(writer, watcher(api, watcher::Config::default()))
        .default_backoff()
        .boxed();

    pump(
        mgr,
        cid,
        reader,
        stream,
        id,
        super::mappers::uid_of,
        move |o| Some(mappers::map_dynamic(o, namespaced, &columns)),
        identity,
    )
    .await;
}

/// The shared watch loop: coalesce watch events, then emit a full post-processed
/// snapshot at most once per [`DEBOUNCE`]. Generic over the object type so typed
/// and dynamic watchers share one implementation.
#[allow(clippy::too_many_arguments)]
async fn pump<R: Runtime, K>(
    mgr: Arc<ClientManager<R>>,
    cid: Cid,
    reader: reflector::Store<K>,
    mut stream: BoxStream<'static, Result<watcher::Event<K>, watcher::Error>>,
    kind: String,
    // The stable row uid for an object (k8s uid, else namespace/name) — passed
    // in because K's DynamicType varies across callers and the bound would
    // otherwise be ambiguous.
    uid_of: fn(&K) -> String,
    // Option, not Row: the Helm watcher (B26) sees Secrets it can't decode, and a
    // watcher that must invent a row for every object it's handed would have to
    // put junk in the table.
    map_fn: impl Fn(&K) -> Option<Row>,
    post_fn: fn(Vec<Row>) -> Vec<Row>,
) where
    K: Lookup + Clone + 'static,
    K::DynamicType: Eq + Hash + Clone,
{
    // A ticker gates emits to at most one per DEBOUNCE window.
    let mut ticker = interval(DEBOUNCE);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    // B74-L: the kind is spawned and trying to sync until the first emit proves
    // it live — the UI shows "starting" rather than an empty table meanwhile.
    mgr.report_watcher(&cid, &kind, WatcherState::Starting, None).await;

    // B78: within the debounce window, accumulate the changed rows by uid
    // (Some(row) = upsert, None = delete) from the watch events themselves,
    // instead of re-reading and re-mapping all N rows on every tick.
    let mut changed: HashMap<String, Option<Row>> = HashMap::new();
    // The Events kind's post-processor sorts + caps the whole set (B14), so it
    // can't delta; and a periodic full-snapshot resync is the escape hatch that
    // corrects any drift a missed event could cause.
    let is_events = kind == ResourceKind::Events.id();
    let mut since_snapshot = 0u32;

    loop {
        tokio::select! {
            // A watch event carries the changed object; the reflector store is
            // already updated. Collect it for the next delta.
            ev = stream.next() => match ev {
                Some(Ok(watcher::Event::Apply(obj))) => {
                    changed.insert(uid_of(&obj), map_fn(&obj));
                }
                Some(Ok(watcher::Event::Delete(obj))) => {
                    changed.insert(uid_of(&obj), None);
                }
                Some(Ok(_)) => {} // Init/InitDone/Restarted markers carry no row
                Some(Err(e)) => {
                    // Logged, not fatal — backoff will retry this one kind (B74-L).
                    // A 403 marks it Forbidden (retries won't help until RBAC
                    // changes); anything else is a transient Backoff.
                    let (state, env) = classify_watch_error(&e, &kind);
                    tracing::warn!("watch {kind} error ({state:?}): {e}");
                    mgr.report_watcher(&cid, &kind, state, Some(env)).await;
                }
                None => break, // stream ended (client dropped on reset)
            },
            // Debounce window elapsed; emit a delta (or a resync snapshot).
            _ = ticker.tick() => {
                since_snapshot += 1;
                let resync = is_events || since_snapshot >= RESYNC_EVERY;
                if resync {
                    since_snapshot = 0;
                    let rows: Vec<Row> =
                        reader.state().iter().filter_map(|o| map_fn(o.as_ref())).collect();
                    let rows = post_fn(rows);
                    // Full snapshot on `resource-update:{cid}` (cached for re-switch).
                    mgr.emit_rows(&cid, kind.clone(), rows).await;
                } else if !changed.is_empty() {
                    let upserts: Vec<Row> = changed.values().filter_map(|v| v.clone()).collect();
                    let deletes: Vec<String> = changed
                        .iter()
                        .filter(|(_, v)| v.is_none())
                        .map(|(uid, _)| uid.clone())
                        .collect();
                    mgr.emit_delta(&cid, kind.clone(), upserts, deletes).await;
                }
                if resync || !changed.is_empty() {
                    // Any emit proves the watcher is live; refresh the last-success
                    // age (throttled by the manager, so this isn't chatty).
                    mgr.report_watcher(&cid, &kind, WatcherState::Live, None).await;
                }
                changed.clear();
            }
        }
    }
}

/// Classify a watcher stream error into a health state + typed envelope (B74-L).
/// A 403 marks the kind Forbidden — retrying won't help until RBAC changes — and
/// everything else is a transient Backoff the watcher's own backoff will retry.
fn classify_watch_error(e: &watcher::Error, kind: &str) -> (WatcherState, ErrorEnvelope) {
    let code = match e {
        watcher::Error::WatchError(resp) => api_status_code(resp.code),
        watcher::Error::InitialListFailed(k)
        | watcher::Error::WatchStartFailed(k)
        | watcher::Error::WatchFailed(k) => match k {
            kube::Error::Api(a) => api_status_code(a.code),
            _ => ErrorCode::Unreachable,
        },
        // NoResourceVersion and anything else: transient.
        _ => ErrorCode::Unreachable,
    };
    let state = if code == ErrorCode::Forbidden {
        WatcherState::Forbidden
    } else {
        WatcherState::Backoff
    };
    let env = AppError::envelope_for_code(code, e.to_string(), Some(kind));
    (state, env)
}

/// Map an HTTP status from an API error to the envelope code.
fn api_status_code(code: u16) -> ErrorCode {
    match code {
        401 => ErrorCode::Auth,
        403 => ErrorCode::Forbidden,
        404 | 410 => ErrorCode::NotFound,
        409 => ErrorCode::Conflict,
        // 5xx / 429 are transient; the watcher's backoff retries them.
        _ => ErrorCode::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use kube::core::ErrorResponse;

    /// A 403 on the initial list is Forbidden; a transport failure is Backoff.
    #[test]
    fn watch_errors_classify_forbidden_vs_transient() {
        let forbidden = watcher::Error::WatchError(ErrorResponse {
            status: "Failure".into(),
            message: "forbidden".into(),
            reason: "Forbidden".into(),
            code: 403,
        });
        let (state, env) = classify_watch_error(&forbidden, "secrets");
        assert_eq!(state, WatcherState::Forbidden);
        assert_eq!(env.code, ErrorCode::Forbidden);
        assert_eq!(env.kind.as_deref(), Some("secrets"));

        let transport = watcher::Error::WatchError(ErrorResponse {
            status: "Failure".into(),
            message: "gone".into(),
            reason: "Expired".into(),
            code: 410,
        });
        let (state, env) = classify_watch_error(&transport, "pods");
        assert_eq!(state, WatcherState::Backoff);
        assert_eq!(env.code, ErrorCode::NotFound);
    }
}
