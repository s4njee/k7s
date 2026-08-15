//! Helm releases (B26), read from the cluster rather than from the `helm` CLI.
//!
//! Helm stores each release as a Secret of type `helm.sh/release.v1`, whose
//! `release` key holds the release JSON gzipped and base64'd. (Kubernetes then
//! base64s the whole thing again for transport, which the client undoes — so what
//! we get handed is still base64 *text*.) Decoding that is the whole feature:
//! everything Lens shows for a release is in there, including the rendered
//! manifest.
//!
//! Two things the storage format makes easy to get wrong:
//!
//!   - **Every revision is its own Secret.** A release upgraded five times has
//!     `…v1` through `…v5`, of which four are `superseded`. `helm list` shows only
//!     the latest, and so must we, or an upgraded release appears five times.
//!   - **The rendered manifest can contain Secrets**, with their values in the
//!     clear. The app redacts Secret values everywhere else (see
//!     docs/verification.md), so it redacts them here too rather than leaving a
//!     hole behind a different door.

use super::dto::{Cell, Row, Tone};
use crate::error::{AppError, AppResult};
use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, DeleteParams, ListParams, Patch, PatchParams, PostParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::{Client, ResourceExt};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

/// The Secret type Helm uses for release storage.
pub const RELEASE_SECRET_TYPE: &str = "helm.sh/release.v1";

/// A decoded Helm release.
pub struct Release {
    pub name: String,
    pub namespace: String,
    /// Chart name and version, as `helm list` renders it ("traefik-27.0.2").
    pub chart: String,
    pub app_version: String,
    pub revision: i64,
    /// deployed | superseded | failed | pending-install | …
    pub status: String,
    /// RFC3339 last-deployed time, or empty.
    pub updated: String,
    /// e.g. "Install complete", "Upgrade complete".
    pub description: String,
    /// RFC3339 first-deployed time (the release's creation), or empty.
    pub first_deployed: String,
    /// The user-supplied values overrides (Helm's `config`); an object, possibly
    /// empty. Chart defaults live under `chart.values` and are deliberately not
    /// surfaced — "what did *I* set" is the question this answers (B35).
    pub config: serde_json::Value,
    /// The rendered manifest, with any Secret values redacted.
    pub manifest: String,
}

// ---------------------------------------------------------------------------
// The on-disk shape (only the parts we use; Helm's JSON is much larger)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ReleaseJson {
    #[serde(default)]
    name: String,
    #[serde(default)]
    namespace: String,
    /// The revision number. Helm calls it "version"; the CLI shows "REVISION".
    #[serde(default)]
    version: i64,
    #[serde(default)]
    info: InfoJson,
    #[serde(default)]
    chart: ChartJson,
    /// User-supplied values overrides.
    #[serde(default)]
    config: serde_json::Value,
    #[serde(default)]
    manifest: String,
}

#[derive(Deserialize, Default)]
struct InfoJson {
    #[serde(default)]
    status: String,
    #[serde(default)]
    first_deployed: String,
    #[serde(default)]
    last_deployed: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize, Default)]
struct ChartJson {
    #[serde(default)]
    metadata: ChartMeta,
}

#[derive(Deserialize, Default)]
struct ChartMeta {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default, rename = "appVersion")]
    app_version: String,
}

/// Placeholder for an unset value.
const DASH: &str = "—";

fn or_dash(s: String) -> String {
    if s.is_empty() {
        DASH.into()
    } else {
        s
    }
}

/// Decode a Helm release Secret, or None if it isn't one / can't be read.
///
/// Undecodable releases are skipped rather than surfaced: a release written by a
/// future Helm, or a truncated Secret, shouldn't put a broken row in the table.
pub fn decode_release(secret: &Secret) -> Option<Release> {
    if secret.type_.as_deref() != Some(RELEASE_SECRET_TYPE) {
        return None;
    }
    let raw = &secret.data.as_ref()?.get("release")?.0;

    // base64 text → gzip bytes → JSON. Helm's own encoding, on top of the
    // transport base64 the client already undid.
    let gz = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| tracing::warn!("helm release {}: bad base64: {e}", secret.name_any()))
        .ok()?;

    let mut json = String::new();
    GzDecoder::new(&gz[..])
        .read_to_string(&mut json)
        .map_err(|e| tracing::warn!("helm release {}: bad gzip: {e}", secret.name_any()))
        .ok()?;

    let r: ReleaseJson = serde_json::from_str(&json)
        .map_err(|e| tracing::warn!("helm release {}: bad json: {e}", secret.name_any()))
        .ok()?;

    // Chart is "name-version", the form `helm list` prints.
    let chart = match (r.chart.metadata.name.as_str(), r.chart.metadata.version.as_str()) {
        ("", _) => DASH.to_string(),
        (n, "") => n.to_string(),
        (n, v) => format!("{n}-{v}"),
    };

    Some(Release {
        // Prefer the release's own namespace; fall back to the Secret's.
        namespace: if r.namespace.is_empty() {
            secret.namespace().unwrap_or_default()
        } else {
            r.namespace
        },
        name: r.name,
        chart,
        app_version: or_dash(r.chart.metadata.app_version),
        revision: r.version,
        status: or_dash(r.info.status),
        updated: r.info.last_deployed,
        first_deployed: r.info.first_deployed,
        description: or_dash(r.info.description),
        config: r.config,
        manifest: redact_secret_manifests(&r.manifest),
    })
}

/// Tone for a release status, matching how the statuses actually read:
/// `deployed` is the healthy resting state, `superseded` is normal history, and
/// anything failed or stuck mid-operation wants attention.
pub fn status_tone(status: &str) -> Tone {
    match status {
        "deployed" => Tone::Good,
        "superseded" | "uninstalled" => Tone::Muted,
        "failed" => Tone::Bad,
        // pending-install / pending-upgrade / pending-rollback / uninstalling:
        // an operation is in flight, or died holding the lock.
        _ => Tone::Warn,
    }
}

/// Whether a values key names a credential, and so must be redacted (B35). Matches
/// the substrings the manifest/secret stance already treats as sensitive; a values
/// blob is exactly where a `dbPassword` or `apiToken` ends up.
fn is_sensitive_key(key: &str) -> bool {
    let k = key.to_lowercase();
    ["password", "secret", "token", "key"].iter().any(|p| k.contains(p))
}

/// Flatten a release's values into sorted `dotted.path` → value pairs, redacting
/// any value under a sensitive key (B35). A sensitive key's whole subtree is
/// replaced by `<redacted>` — the value string never reaches the caller, so it
/// can't reach the frontend payload.
///
/// Nested objects dot together (`resources.limits.cpu`); arrays index
/// (`hosts.0`). Scalars render as their JSON text without quotes.
pub fn flatten_values(config: &serde_json::Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    // Values is an object (or absent/null); a top-level scalar isn't a real Helm
    // config, so it yields nothing rather than a nameless row.
    if config.is_object() || config.is_array() {
        flatten_into("", config, &mut out);
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn flatten_into(prefix: &str, value: &serde_json::Value, out: &mut Vec<(String, String)>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                if is_sensitive_key(k) {
                    // Redact the whole subtree — never descend into a credential.
                    out.push((path, "<redacted>".to_string()));
                } else {
                    flatten_into(&path, v, out);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                let path = if prefix.is_empty() { i.to_string() } else { format!("{prefix}.{i}") };
                flatten_into(&path, v, out);
            }
        }
        serde_json::Value::String(s) => out.push((prefix.to_string(), s.clone())),
        serde_json::Value::Null => out.push((prefix.to_string(), DASH.to_string())),
        other => out.push((prefix.to_string(), other.to_string())),
    }
}

/// Map a release Secret to a table row: NAME, NAMESPACE, CHART, APP VERSION,
/// REVISION, STATUS, UPDATED. None for anything that isn't a readable release.
pub fn map_release(secret: &Secret) -> Option<Row> {
    let r = decode_release(secret)?;
    let cells = vec![
        Cell::new(r.name.clone(), Tone::Primary),
        Cell::new(r.namespace.clone(), Tone::Muted),
        Cell::new(r.chart, Tone::Secondary),
        Cell::new(r.app_version, Tone::Secondary),
        // The revision carries a numeric sort key: `latest_only` uses it, and it
        // stops "10" sorting before "9" in the column.
        Cell::new(r.revision.to_string(), Tone::Secondary).with_sort(r.revision as f64),
        Cell::status(r.status.clone(), status_tone(&r.status)),
        Cell::age(Some(r.updated.clone()).filter(|u| !u.is_empty())),
    ];
    Some(Row {
        // Identity is the release, not the Secret: the row for a release should
        // keep its selection across an upgrade rather than being a new row.
        uid: format!("helm:{}/{}", r.namespace, r.name),
        name: r.name,
        namespace: Some(r.namespace),
        cells,
        ..Default::default()
    })
}

/// Keep only each release's newest revision, newest release first.
///
/// Helm never deletes old revision Secrets (it keeps ten by default), so without
/// this an upgraded release would appear once per revision — mostly as
/// `superseded` rows nobody asked for. This is what `helm list` shows.
pub fn latest_only(rows: Vec<Row>) -> Vec<Row> {
    use std::collections::HashMap;

    let revision = |r: &Row| r.cells.get(4).and_then(|c| c.sort).unwrap_or(0.0);

    // uid is already "helm:namespace/name" — the release's identity.
    let mut newest: HashMap<String, Row> = HashMap::new();
    for row in rows {
        match newest.get(&row.uid) {
            Some(existing) if revision(existing) >= revision(&row) => {}
            _ => {
                newest.insert(row.uid.clone(), row);
            }
        }
    }

    let mut out: Vec<Row> = newest.into_values().collect();
    // Most recently updated first: what you just deployed is what you're looking
    // for. Ties (and undated releases) fall back to name for a stable order.
    out.sort_by(|a, b| {
        let updated = |r: &Row| r.cells.get(6).map(|c| c.text.clone()).unwrap_or_default();
        updated(b).cmp(&updated(a)).then_with(|| a.name.cmp(&b.name))
    });
    out
}

// ---------------------------------------------------------------------------
// Helm write path (B81): rollback + uninstall, Phase 1
// ---------------------------------------------------------------------------
//
// The write direction is exactly the inverse of the decode chain above —
// `base64(gzip(JSON))` — so rolling back and uninstalling need no new
// dependency. A rollback writes a *new* revision Secret the way `helm rollback`
// does (version = current+1, status deployed, description "Rollback to N", the
// target revision's chart/config/manifest copied verbatim — verified against a
// real Helm 4.2.3 rollback) and marks the previously-deployed revision
// superseded, so `helm history` reads correctly both ways.

/// A release's rendered manifest, parsed into its YAML documents (B46). A stray
/// `---` or an unparsable document is skipped, not a failure.
pub fn manifest_docs(manifest: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for doc in serde_yaml::Deserializer::from_str(manifest) {
        // YAML → serde_json::Value directly (YAML is a superset, but the docs a
        // Helm manifest emits map cleanly; an unparsable doc is skipped).
        let Ok(v) = serde_json::Value::deserialize(doc) else { continue };
        out.push(v);
    }
    out
}

/// Kind/name pairs of the objects a release's rendered manifest installs (B46).
/// Parsed from the document, not by a schema: a Helm chart can install any
/// object, including CRDs we don't model.
pub fn manifest_objects(manifest: &str) -> Vec<(String, String)> {
    manifest_docs(manifest)
        .iter()
        .filter_map(|d| {
            let kind = d.get("kind")?.as_str()?.to_string();
            let name = d.pointer("/metadata/name")?.as_str()?.to_string();
            (!kind.is_empty() && !name.is_empty()).then_some((kind, name))
        })
        .collect()
}

/// Decode a release Secret's *full* payload as JSON — unredacted, unlike the
/// display [`decode_release`]. The write path must never round-trip the redacted
/// manifest: a chart's Secret values live in the raw payload and a rollback that
/// stored `<redacted>` in their place would destroy them.
pub fn raw_release(secret: &Secret) -> Option<serde_json::Value> {
    if secret.type_.as_deref() != Some(RELEASE_SECRET_TYPE) {
        return None;
    }
    let raw = &secret.data.as_ref()?.get("release")?.0;
    let gz = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| tracing::warn!("helm release {}: bad base64: {e}", secret.name_any()))
        .ok()?;
    let mut json = String::new();
    GzDecoder::new(&gz[..])
        .read_to_string(&mut json)
        .map_err(|e| tracing::warn!("helm release {}: bad gzip: {e}", secret.name_any()))
        .ok()?;
    serde_json::from_str(&json)
        .map_err(|e| tracing::warn!("helm release {}: bad json: {e}", secret.name_any()))
        .ok()
}

/// Encode a release payload the way Helm stores it: `base64(gzip(JSON))` — the
/// text that goes in the Secret's `release` data key (the transport base64 the
/// API layer adds is handled by the typed `Secret`).
fn encode_release(value: &serde_json::Value) -> Option<String> {
    let body = serde_json::to_vec(value).ok()?;
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&body).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(gz.finish().ok()?))
}

/// The Secret name Helm uses for one revision of a release.
fn release_secret_name(name: &str, version: i64) -> String {
    format!("sh.helm.release.v1.{name}.v{version}")
}

/// Build the Secret for one revision from an encoded payload (B81). Labels match
/// what Helm itself sets, so `helm history` / `helm list` see the write.
fn build_secret(ns: &str, name: &str, version: i64, status: &str, payload: &serde_json::Value) -> AppResult<Secret> {
    let encoded = encode_release(payload)
        .ok_or_else(|| AppError::Other(format!("could not encode release {ns}/{name}")))?;
    // The `release` value is Helm's own `base64(gzip(json))` text; the Secret
    // data map transport-base64s it again, which the typed `ByteString`
    // deserializer undoes — so what the API stores matches a real Helm Secret.
    let release_data = base64::engine::general_purpose::STANDARD.encode(encoded.as_bytes());
    serde_json::from_value(serde_json::json!({
        "metadata": {
            "name": release_secret_name(name, version),
            "namespace": ns,
            "labels": {
                "owner": "helm",
                "name": name,
                "version": version.to_string(),
                "status": status,
                "modifiedAt": chrono::Utc::now().timestamp().to_string(),
            },
        },
        "type": RELEASE_SECRET_TYPE,
        "data": { "release": release_data },
    }))
    .map_err(|e| AppError::Other(format!("could not build release Secret: {e}")))
}

/// The payload of a rollback revision: the target revision's payload untouched
/// except version, status, last-deployed and description — exactly what
/// `helm rollback` writes (verified against a real Helm 4.2.3 rollback).
pub fn build_rollback_payload(target: &serde_json::Value, next_version: i64, now: &str) -> serde_json::Value {
    let mut v = target.clone();
    v["version"] = serde_json::json!(next_version);
    if let Some(info) = v.get_mut("info") {
        info["status"] = serde_json::json!("deployed");
        info["last_deployed"] = serde_json::json!(now);
        info["description"] = serde_json::json!(format!(
            "Rollback to {}",
            target["version"].as_i64().unwrap_or(next_version - 1)
        ));
    }
    v
}

/// Flip a release payload to superseded — what Helm does to the previously
/// deployed revision when a new one lands, so history reads one deployed row.
pub fn mark_superseded(payload: &mut serde_json::Value) {
    if let Some(info) = payload.get_mut("info") {
        info["status"] = serde_json::json!("superseded");
    }
}

/// List a release's revision Secrets, refusing anything that isn't Helm 3
/// storage v1 (B81). An empty list, or a Secret that fails the v1 decode, is a
/// clean error — never a guess at a v2/Tiller layout.
async fn release_secrets(client: &Client, ns: &str, name: &str) -> AppResult<Vec<Secret>> {
    let api: Api<Secret> = Api::namespaced(client.clone(), ns);
    let lp = ListParams::default()
        .labels(&format!("owner=helm,name={name}"))
        .fields(&format!("type={RELEASE_SECRET_TYPE}"));
    let list = api.list(&lp).await.map_err(|e| AppError::Kube(e.to_string()))?;
    if list.items.is_empty() {
        return Err(AppError::NotFound(format!("no Helm release {name} in {ns}")));
    }
    if list.items.iter().any(|s| raw_release(s).is_none()) {
        return Err(AppError::Other(format!(
            "release {ns}/{name} uses a storage layout that isn't Helm 3 storage v1"
        )));
    }
    Ok(list.items)
}

/// Resolve a manifest's `kind` to (group, version, plural) for the kinds a chart
/// typically renders. A kind we don't model (a CRD, say) is skipped, not guessed
/// — applying a guessed GVK would be worse than leaving the object alone.
fn manifest_gvk(kind: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match kind {
        "ConfigMap" => ("", "v1", "configmaps"),
        "Secret" => ("", "v1", "secrets"),
        "Service" => ("", "v1", "services"),
        "ServiceAccount" => ("", "v1", "serviceaccounts"),
        "PersistentVolumeClaim" => ("", "v1", "persistentvolumeclaims"),
        "PersistentVolume" => ("", "v1", "persistentvolumes"),
        "Namespace" => ("", "v1", "namespaces"),
        "Node" => ("", "v1", "nodes"),
        "Pod" => ("", "v1", "pods"),
        "Deployment" => ("apps", "v1", "deployments"),
        "StatefulSet" => ("apps", "v1", "statefulsets"),
        "DaemonSet" => ("apps", "v1", "daemonsets"),
        "ReplicaSet" => ("apps", "v1", "replicasets"),
        "Job" => ("batch", "v1", "jobs"),
        "CronJob" => ("batch", "v1", "cronjobs"),
        "Ingress" => ("networking.k8s.io", "v1", "ingresses"),
        "IngressClass" => ("networking.k8s.io", "v1", "ingressclasses"),
        "NetworkPolicy" => ("networking.k8s.io", "v1", "networkpolicies"),
        "HorizontalPodAutoscaler" => ("autoscaling", "v2", "horizontalpodautoscalers"),
        "PodDisruptionBudget" => ("policy", "v1", "poddisruptionbudgets"),
        "Role" => ("rbac.authorization.k8s.io", "v1", "roles"),
        "ClusterRole" => ("rbac.authorization.k8s.io", "v1", "clusterroles"),
        "RoleBinding" => ("rbac.authorization.k8s.io", "v1", "rolebindings"),
        "ClusterRoleBinding" => ("rbac.authorization.k8s.io", "v1", "clusterrolebindings"),
        "StorageClass" => ("storage.k8s.io", "v1", "storageclasses"),
        _ => return None,
    })
}

/// Apply a release's rendered manifest — server-side apply per document, the way
/// Helm 4 itself applies — so a rollback brings the cluster's objects to the
/// target revision. Namespaces first; a kind we can't resolve is skipped with a
/// warning rather than failing the rollback. **On any failure nothing is
/// recorded** — the caller writes no release Secret, matching a helm rollback
/// that failed to apply.
///
/// The field manager is `helm`, matching what the helm CLI uses (its binary
/// name): a later `helm rollback`/`helm upgrade` then owns the same fields and
/// doesn't fail with an SSA conflict against k7s's earlier write.
async fn apply_manifest(client: &Client, ns: &str, manifest: &str) -> AppResult<()> {
    let mut docs = manifest_docs(manifest);
    // Namespaces first: a namespaced object needs its namespace to exist.
    docs.sort_by_key(|d| {
        if d.get("kind").and_then(|k| k.as_str()) == Some("Namespace") { 0 } else { 1 }
    });

    for doc in docs {
        let Some(kind) = doc.get("kind").and_then(|k| k.as_str()).map(String::from) else { continue };
        let Some(name) = doc.pointer("/metadata/name").and_then(|n| n.as_str()).map(String::from) else { continue };
        let obj_ns = doc
            .pointer("/metadata/namespace")
            .and_then(|n| n.as_str())
            .map(String::from)
            .unwrap_or_else(|| ns.to_string());
        let Some((g, v, plural)) = manifest_gvk(&kind) else {
            tracing::warn!("helm rollback: skipping unresolvable manifest kind {kind}/{name} (CRDs are out of Phase-1 scope)");
            continue;
        };
        let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(g, v, &kind), plural);
        let api: Api<DynamicObject> = if obj_ns.is_empty() {
            Api::all_with(client.clone(), &ar)
        } else {
            Api::namespaced_with(client.clone(), &obj_ns, &ar)
        };
        let pp = PatchParams {
            field_manager: Some("helm".into()),
            force: true,
            ..Default::default()
        };
        api.patch(&name, &pp, &Patch::Apply(doc))
            .await
            .map_err(|e| AppError::Kube(e.to_string()))?;
    }
    Ok(())
}

/// Roll a release back to an earlier revision (B81 Phase 1): apply that
/// revision's stored manifest so the cluster actually reflects it, mark the
/// currently-deployed revision superseded, and write a new revision Secret the
/// way `helm rollback` does — so `helm history` shows the rollback.
///
/// Returns the new revision. Deliberately not full helm parity: hooks aren't run
/// and objects the target manifest no longer lists aren't pruned (Phase-1 scope).
pub async fn rollback(client: Client, ns: &str, name: &str, revision: i64) -> AppResult<i64> {
    let secrets = release_secrets(&client, ns, name).await?;
    let mut payloads: Vec<(Secret, serde_json::Value)> = secrets
        .iter()
        .filter_map(|s| raw_release(s).map(|v| (s.clone(), v)))
        .collect();

    // The target revision's payload, cloned so `payloads` can be mutated for the
    // supersede step below (a release JSON is a few KB at most).
    let target = payloads
        .iter()
        .find(|(_, v)| v["version"].as_i64() == Some(revision))
        .ok_or_else(|| AppError::Other(format!("no revision {revision} of {ns}/{name}")))?
        .1
        .clone();
    let max_version = payloads
        .iter()
        .map(|(_, v)| v["version"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    if revision >= max_version {
        return Err(AppError::Other(format!(
            "release {ns}/{name} is already at revision {max_version}"
        )));
    }

    // 1. Bring the cluster's objects to the target revision. On failure nothing
    //    is recorded (no release Secret is written).
    let manifest = target["manifest"].as_str().unwrap_or_default().to_string();
    apply_manifest(&client, ns, &manifest).await?;

    // 2. Supersede the currently-deployed revision, as helm does, so history
    //    reads one deployed row.
    if let Some((cur, cur_v)) = payloads
        .iter_mut()
        .find(|(_, v)| v["version"].as_i64() == Some(max_version))
    {
        mark_superseded(cur_v);
        let encoded = encode_release(cur_v)
            .ok_or_else(|| AppError::Other(format!("could not encode release {ns}/{name}")))?;
        // Secret data is base64 on the wire and the API server decodes it once —
        // so send the transport form of the base64 text, like build_secret.
        let release_data = base64::engine::general_purpose::STANDARD.encode(encoded.as_bytes());
        let cur_name = cur.metadata.name.clone().unwrap_or_default();
        let api: Api<Secret> = Api::namespaced(client.clone(), ns);
        api.patch(
            &cur_name,
            &PatchParams::default(),
            &Patch::Merge(serde_json::json!({
                "data": { "release": release_data },
                "metadata": { "labels": { "status": "superseded" } },
            })),
        )
        .await
        .map_err(|e| AppError::Kube(e.to_string()))?;
    }

    // 3. Write the new revision.
    let now = chrono::Utc::now().to_rfc3339();
    let new_payload = build_rollback_payload(&target, max_version + 1, &now);
    let secret = build_secret(ns, name, max_version + 1, "deployed", &new_payload)?;
    let api: Api<Secret> = Api::namespaced(client.clone(), ns);
    api.create(&PostParams::default(), &secret)
        .await
        .map_err(|e| AppError::Kube(e.to_string()))?;
    Ok(max_version + 1)
}

/// What an uninstall removed.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOutcome {
    pub objects_deleted: usize,
    pub secrets_deleted: usize,
}

/// Uninstall a release (B81 Phase 1): delete the objects its manifest installs
/// (a missing object is "already gone", not a failure) and the release's
/// revision Secrets — the default `helm uninstall` semantics, no keep-history.
pub async fn uninstall(client: Client, ns: &str, name: &str) -> AppResult<UninstallOutcome> {
    let secrets = release_secrets(&client, ns, name).await?;

    // The objects the release currently has, from the latest revision's manifest.
    let latest = secrets
        .iter()
        .filter_map(raw_release)
        .max_by_key(|v| v["version"].as_i64().unwrap_or(0))
        .ok_or_else(|| AppError::NotFound(format!("no Helm release {name} in {ns}")))?;
    let mut objects_deleted = 0;
    for doc in manifest_docs(latest["manifest"].as_str().unwrap_or_default()) {
        let Some(kind) = doc.get("kind").and_then(|k| k.as_str()) else { continue };
        let Some(obj_name) = doc.pointer("/metadata/name").and_then(|n| n.as_str()) else { continue };
        let obj_ns = doc.pointer("/metadata/namespace").and_then(|n| n.as_str()).unwrap_or(ns);
        let Some((g, v, plural)) = manifest_gvk(kind) else {
            tracing::warn!("helm uninstall: skipping unresolvable manifest kind {kind}/{obj_name}");
            continue;
        };
        let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(g, v, kind), plural);
        let api: Api<DynamicObject> = if obj_ns.is_empty() {
            Api::all_with(client.clone(), &ar)
        } else {
            Api::namespaced_with(client.clone(), obj_ns, &ar)
        };
        match api.delete(obj_name, &DeleteParams::default()).await {
            Ok(_) => objects_deleted += 1,
            // Already gone — the accept's "missing manifest object degrades gracefully".
            Err(kube::Error::Api(resp)) if resp.code == 404 => {}
            Err(e) => return Err(AppError::Kube(e.to_string())),
        }
    }

    let mut secrets_deleted = 0;
    let api: Api<Secret> = Api::namespaced(client.clone(), ns);
    for s in &secrets {
        let secret_name = s.metadata.name.clone().unwrap_or_default();
        match api.delete(&secret_name, &DeleteParams::default()).await {
            Ok(_) => secrets_deleted += 1,
            Err(kube::Error::Api(resp)) if resp.code == 404 => {}
            Err(e) => return Err(AppError::Kube(e.to_string())),
        }
    }

    Ok(UninstallOutcome { objects_deleted, secrets_deleted })
}

// ---------------------------------------------------------------------------
// Manifest redaction
// ---------------------------------------------------------------------------

/// Redact Secret values inside a rendered manifest.
///
/// A chart that ships a Secret renders it with its values in the clear. The app
/// redacts Secret values in every other view, so showing them here would just be
/// the same leak through a different door.
///
/// Works line-wise on the specific documents that are Secrets, rather than
/// parsing and re-emitting the YAML: Helm's output carries `# Source:` comments
/// that say which template produced each document, and a round-trip through a
/// YAML parser would throw them away.
fn redact_secret_manifests(manifest: &str) -> String {
    if manifest.is_empty() {
        return String::new();
    }
    manifest
        .split("\n---")
        .map(|doc| if is_secret_doc(doc) { redact_doc(doc) } else { doc.to_string() })
        .collect::<Vec<_>>()
        .join("\n---")
}

/// True when a manifest document declares a core/v1 Secret.
fn is_secret_doc(doc: &str) -> bool {
    let mut kind_is_secret = false;
    for line in doc.lines() {
        let t = line.trim();
        // Only top-level keys count: a Deployment mounting a secret has
        // "kind: Secret" nested under a volume, and that's not a Secret document.
        if !line.starts_with("kind:") {
            continue;
        }
        if t == "kind: Secret" {
            kind_is_secret = true;
        }
    }
    kind_is_secret
}

/// Replace the values under `data:` / `stringData:` with a placeholder.
fn redact_doc(doc: &str) -> String {
    let mut out = Vec::new();
    // Indentation of the data block we're inside, if any.
    let mut in_data_block = false;

    for line in doc.lines() {
        let trimmed = line.trim_end();
        if trimmed == "data:" || trimmed == "stringData:" {
            in_data_block = true;
            out.push(line.to_string());
            continue;
        }
        if in_data_block {
            let indent = line.len() - line.trim_start().len();
            // A non-indented, non-empty line ends the block.
            if !line.trim().is_empty() && indent == 0 {
                in_data_block = false;
            } else if let Some((key, _)) = line.split_once(':') {
                if !line.trim().is_empty() {
                    out.push(format!("{key}: <redacted>"));
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    let mut s = out.join("\n");
    // `lines()` drops a trailing newline; keep the document's shape.
    if doc.ends_with('\n') {
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use serde_json::json;
    use std::io::Write;

    /// Build a release Secret exactly as the cluster hands one to us.
    ///
    /// The double encoding is the point, and it's easy to get wrong: Helm writes
    /// `base64(gzip(json))` as the *value*, and Kubernetes then base64s every
    /// Secret value again for transport — which `ByteString`'s deserializer
    /// undoes. So the bytes our code receives are still base64 text, and a
    /// fixture that encodes only once tests a decoder no cluster will ever feed.
    fn release_secret(name: &str, ns: &str, revision: i64, status: &str, updated: &str) -> Secret {
        let body = json!({
            "name": name,
            "namespace": ns,
            "version": revision,
            "info": { "status": status, "last_deployed": updated, "description": "Install complete" },
            "chart": { "metadata": { "name": "traefik", "version": "27.0.2", "appVersion": "v3.0.0" } },
            "manifest": "# Source: traefik/templates/svc.yaml\napiVersion: v1\nkind: Service\n",
        });
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(body.to_string().as_bytes()).unwrap();
        // What Helm stores in the value: base64 text.
        let helm_value = base64::engine::general_purpose::STANDARD.encode(gz.finish().unwrap());
        // What the API serialises: that text, base64'd again for transport.
        let transport = base64::engine::general_purpose::STANDARD.encode(helm_value.as_bytes());

        serde_json::from_value(json!({
            "metadata": { "name": format!("sh.helm.release.v1.{name}.v{revision}"), "namespace": ns },
            "type": RELEASE_SECRET_TYPE,
            "data": { "release": transport },
        }))
        .unwrap()
    }

    /// The full Helm encoding chain round-trips into the columns we show.
    #[test]
    fn decodes_a_release() {
        let s = release_secret("traefik", "kube-system", 1, "deployed", "2026-06-28T09:30:13Z");
        let r = decode_release(&s).expect("should decode");
        assert_eq!(r.name, "traefik");
        assert_eq!(r.namespace, "kube-system");
        assert_eq!(r.chart, "traefik-27.0.2", "chart reads as helm list prints it");
        assert_eq!(r.app_version, "v3.0.0");
        assert_eq!(r.revision, 1);
        assert_eq!(r.status, "deployed");
    }

    /// Non-Helm Secrets are not releases, and must not be decoded or shown.
    #[test]
    fn ignores_ordinary_secrets() {
        let s: Secret = serde_json::from_value(json!({
            "metadata": { "name": "db-creds", "namespace": "prod" },
            "type": "Opaque",
            "data": { "password": "aHVudGVyMg==" },
        }))
        .unwrap();
        assert!(decode_release(&s).is_none());
    }

    /// Garbage in the release key is skipped, not surfaced as a broken row.
    #[test]
    fn undecodable_release_is_skipped() {
        let s: Secret = serde_json::from_value(json!({
            "metadata": { "name": "sh.helm.release.v1.x.v1", "namespace": "prod" },
            "type": RELEASE_SECRET_TYPE,
            // Transport-decodes to "not-gzip", which is valid base64 of nothing useful.
            "data": { "release": "Ym0keUxXZDZhWEE9" },
        }))
        .unwrap();
        assert!(decode_release(&s).is_none());
        assert!(map_release(&s).is_none());
    }

    // ---- values flattening & redaction (B35) ----

    /// A credential value is redacted by key name, and the value string never
    /// appears in the output at all — not just hidden behind a placeholder.
    #[test]
    fn flatten_redacts_credentials() {
        let cfg = json!({
            "dbPassword": "hunter2",
            "api": { "token": "t0psecret", "url": "https://x" },
            "tls": { "key": "PRIVATE", "crt": "public-cert" },
            "clientSecret": "shh",
        });
        let flat = flatten_values(&cfg);
        let dumped = format!("{flat:?}");
        for leaked in ["hunter2", "t0psecret", "PRIVATE", "shh"] {
            assert!(!dumped.contains(leaked), "credential '{leaked}' must not survive flattening");
        }
        // The keys are still listed, as <redacted>, so the shape stays visible.
        let redacted: Vec<_> = flat.iter().filter(|(_, v)| v == "<redacted>").map(|(k, _)| k.as_str()).collect();
        assert!(redacted.contains(&"dbPassword"));
        assert!(redacted.contains(&"api.token"));
        assert!(redacted.contains(&"tls.key"));
        assert!(redacted.contains(&"clientSecret"));
        // A non-sensitive sibling under the same parent is untouched.
        assert!(flat.iter().any(|(k, v)| k == "api.url" && v == "https://x"));
        assert!(flat.iter().any(|(k, v)| k == "tls.crt" && v == "public-cert"));
    }

    /// Nested objects dot together, arrays index, and the output is sorted.
    #[test]
    fn flatten_paths_and_order() {
        let cfg = json!({
            "replicaCount": 2,
            "resources": { "limits": { "cpu": "500m" } },
            "hosts": ["a.example", "b.example"],
        });
        let flat = flatten_values(&cfg);
        assert_eq!(
            flat,
            vec![
                ("hosts.0".to_string(), "a.example".to_string()),
                ("hosts.1".to_string(), "b.example".to_string()),
                ("replicaCount".to_string(), "2".to_string()),
                ("resources.limits.cpu".to_string(), "500m".to_string()),
            ]
        );
    }

    /// No overrides → no rows; the caller renders "chart defaults" instead.
    #[test]
    fn flatten_empty_config_is_empty() {
        assert!(flatten_values(&json!({})).is_empty());
        assert!(flatten_values(&serde_json::Value::Null).is_empty());
    }

    /// Status colouring: deployed is healthy, superseded is just history, failed
    /// is red, and anything pending is an operation in flight.
    #[test]
    fn status_tones() {
        assert_eq!(status_tone("deployed"), Tone::Good);
        assert_eq!(status_tone("superseded"), Tone::Muted);
        assert_eq!(status_tone("failed"), Tone::Bad);
        assert_eq!(status_tone("pending-upgrade"), Tone::Warn);
    }

    /// The headline behaviour: an upgraded release is one row, at its newest
    /// revision — not one row per revision Secret.
    #[test]
    fn keeps_only_the_newest_revision() {
        let rows: Vec<Row> = vec![
            map_release(&release_secret("traefik", "kube-system", 1, "superseded", "2026-06-01T00:00:00Z")).unwrap(),
            map_release(&release_secret("traefik", "kube-system", 3, "deployed", "2026-06-03T00:00:00Z")).unwrap(),
            map_release(&release_secret("traefik", "kube-system", 2, "superseded", "2026-06-02T00:00:00Z")).unwrap(),
        ];
        let out = latest_only(rows);
        assert_eq!(out.len(), 1, "three revision secrets are one release");
        assert_eq!(out[0].cells[4].text, "3", "and it shows the newest revision");
        assert_eq!(out[0].cells[5].text, "deployed");
    }

    /// Releases in different namespaces with the same name are different releases.
    #[test]
    fn same_name_in_two_namespaces_stays_two_rows() {
        let rows = vec![
            map_release(&release_secret("redis", "prod", 1, "deployed", "2026-06-01T00:00:00Z")).unwrap(),
            map_release(&release_secret("redis", "staging", 1, "deployed", "2026-06-02T00:00:00Z")).unwrap(),
        ];
        assert_eq!(latest_only(rows).len(), 2);
    }

    /// Newest deployment first.
    #[test]
    fn sorts_newest_first() {
        let rows = vec![
            map_release(&release_secret("old", "prod", 1, "deployed", "2026-06-01T00:00:00Z")).unwrap(),
            map_release(&release_secret("new", "prod", 1, "deployed", "2026-06-09T00:00:00Z")).unwrap(),
        ];
        let out = latest_only(rows);
        assert_eq!(out[0].name, "new");
    }

    /// Revisions sort numerically, so 10 beats 9.
    #[test]
    fn revision_ordering_is_numeric_not_lexical() {
        let rows = vec![
            map_release(&release_secret("app", "prod", 9, "superseded", "2026-06-01T00:00:00Z")).unwrap(),
            map_release(&release_secret("app", "prod", 10, "deployed", "2026-06-02T00:00:00Z")).unwrap(),
        ];
        assert_eq!(latest_only(rows)[0].cells[4].text, "10");
    }

    // ---- manifest redaction ----

    /// A Secret rendered by a chart doesn't get to show its values here when
    /// every other view redacts them.
    #[test]
    fn redacts_secret_values_in_the_manifest() {
        let m = "# Source: c/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\ndata:\n  password: aHVudGVyMg==\n  token: c2VjcmV0\n";
        let out = redact_secret_manifests(m);
        assert!(!out.contains("aHVudGVyMg=="), "secret value must not survive");
        assert!(!out.contains("c2VjcmV0"));
        assert!(out.contains("password: <redacted>"));
        assert!(out.contains("token: <redacted>"));
        // The provenance comment is why this is line-wise rather than a YAML
        // round-trip; losing it would make the manifest much harder to read.
        assert!(out.contains("# Source: c/templates/secret.yaml"));
    }

    /// stringData too — same values, different key.
    #[test]
    fn redacts_string_data() {
        let m = "kind: Secret\nstringData:\n  password: hunter2\n";
        assert!(redact_secret_manifests(m).contains("password: <redacted>"));
    }

    /// Non-Secret documents are passed through untouched — a ConfigMap's data is
    /// exactly what you opened the manifest to read.
    #[test]
    fn leaves_other_documents_alone() {
        let m = "kind: ConfigMap\ndata:\n  log_level: debug\n";
        assert!(redact_secret_manifests(m).contains("log_level: debug"));
    }

    /// Only the Secret document in a multi-document manifest is touched.
    #[test]
    fn redacts_only_the_secret_document() {
        let m = "kind: ConfigMap\ndata:\n  keep: yes\n---\nkind: Secret\ndata:\n  hide: c2VjcmV0\n";
        let out = redact_secret_manifests(m);
        assert!(out.contains("keep: yes"));
        assert!(out.contains("hide: <redacted>"));
        assert!(!out.contains("c2VjcmV0"));
    }

    /// "kind: Secret" nested inside a pod spec's volume doesn't make the document
    /// a Secret, and must not trigger redaction of a Deployment.
    #[test]
    fn nested_secret_reference_is_not_a_secret_document() {
        let m = "kind: Deployment\nspec:\n  template:\n    spec:\n      volumes:\n        - secret:\n            kind: Secret\n";
        assert!(!is_secret_doc(m));
    }

    // ---- B81 write path ----

    /// A release payload survives the encode → Secret → raw-decode round trip
    /// with its full chart/config/manifest intact — the write direction must not
    /// drop the payload's non-display fields.
    #[test]
    fn encode_then_raw_decode_round_trips_the_full_payload() {
        let payload = serde_json::json!({
            "name": "app",
            "namespace": "prod",
            "version": 2,
            "info": { "status": "deployed", "first_deployed": "2026-01-01T00:00:00Z",
                      "last_deployed": "2026-02-01T00:00:00Z", "description": "Upgrade complete" },
            "chart": { "metadata": { "name": "app", "version": "0.1.0" },
                       "templates": [{ "name": "templates/c.yaml", "data": "YXBpVmVyc2lvbjogdjE=" }],
                       "values": { "color": "blue" } },
            "config": { "color": "blue" },
            "manifest": "kind: ConfigMap\nmetadata:\n  name: app-config\ndata:\n  color: blue\n",
            "apply_method": "SERVER_SIDE_APPLY",
        });
        let encoded = encode_release(&payload).expect("encodes");
        // Same double base64 as the release_secret() fixture: the value is Helm's
        // base64 text, transport-encoded again for the API layer.
        let transport = base64::engine::general_purpose::STANDARD.encode(encoded.as_bytes());
        let secret: Secret = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "sh.helm.release.v1.app.v2", "namespace": "prod" },
            "type": RELEASE_SECRET_TYPE,
            "data": { "release": transport },
        })).unwrap();
        let back = raw_release(&secret).expect("raw decodes");
        assert_eq!(back["version"], 2);
        assert_eq!(back["info"]["status"], "deployed");
        assert_eq!(back["config"]["color"], "blue");
        assert_eq!(back["chart"]["values"]["color"], "blue", "chart defaults survive");
        assert_eq!(back["chart"]["templates"][0]["data"], "YXBpVmVyc2lvbjogdjE=", "template blob survives");
        assert_eq!(back["apply_method"], "SERVER_SIDE_APPLY", "helm v4's field survives");
    }

    /// A rollback payload is the target's payload with version bumped, status
    /// deployed, last-deployed now and a "Rollback to N" description — everything
    /// else (chart, config, manifest, first_deployed) untouched.
    #[test]
    fn rollback_payload_bumps_version_and_preserves_the_rest() {
        let target = serde_json::json!({
            "name": "app", "namespace": "prod", "version": 1,
            "info": { "status": "superseded", "first_deployed": "2026-01-01T00:00:00Z",
                      "last_deployed": "2026-01-01T00:00:00Z", "description": "Install complete" },
            "chart": { "metadata": { "name": "app", "version": "0.1.0" } },
            "config": { "color": "red" },
            "manifest": "kind: ConfigMap\nmetadata:\n  name: app-config\ndata:\n  color: red\n",
        });
        let rolled = build_rollback_payload(&target, 3, "2026-03-01T00:00:00Z");
        assert_eq!(rolled["version"], 3, "version is the new revision");
        assert_eq!(rolled["info"]["status"], "deployed");
        assert_eq!(rolled["info"]["last_deployed"], "2026-03-01T00:00:00Z");
        assert_eq!(rolled["info"]["description"], "Rollback to 1");
        assert_eq!(rolled["info"]["first_deployed"], "2026-01-01T00:00:00Z", "first_deployed preserved");
        assert_eq!(rolled["chart"], target["chart"], "chart byte-preserved");
        assert_eq!(rolled["config"], target["config"], "values from the target revision");
        assert_eq!(rolled["manifest"], target["manifest"], "manifest from the target revision");
    }

    /// Marking the previously-deployed revision superseded is a single field flip.
    #[test]
    fn mark_superseded_flips_the_status() {
        let mut v = serde_json::json!({ "info": { "status": "deployed" }, "version": 2 });
        mark_superseded(&mut v);
        assert_eq!(v["info"]["status"], "superseded");
        assert_eq!(v["version"], 2, "only the status changes");
    }

    /// The rollback Secret carries Helm's own name/type/labels and round-trips.
    #[test]
    fn build_secret_names_and_labels_like_helm() {
        let payload = serde_json::json!({ "name": "app", "namespace": "prod", "version": 3,
            "info": { "status": "deployed", "first_deployed": "", "last_deployed": "", "description": "" } });
        let secret = build_secret("prod", "app", 3, "deployed", &payload).unwrap();
        assert_eq!(secret.metadata.name.as_deref(), Some("sh.helm.release.v1.app.v3"));
        assert_eq!(secret.type_.as_deref(), Some(RELEASE_SECRET_TYPE));
        let labels = secret.metadata.labels.as_ref().unwrap();
        assert_eq!(labels.get("owner").map(String::as_str), Some("helm"));
        assert_eq!(labels.get("name").map(String::as_str), Some("app"));
        assert_eq!(labels.get("status").map(String::as_str), Some("deployed"));
        assert_eq!(labels.get("version").map(String::as_str), Some("3"));
        let back = raw_release(&secret).expect("round-trips");
        assert_eq!(back["version"], 3);
    }

    /// The manifest parser lists every document's kind/name, skipping `---`.
    #[test]
    fn manifest_objects_lists_documents() {
        let m = "---\nkind: ConfigMap\nmetadata:\n  name: app-config\n---\nkind: Deployment\nmetadata:\n  name: app\n";
        let objects = manifest_objects(m);
        assert_eq!(objects, vec![("ConfigMap".into(), "app-config".into()), ("Deployment".into(), "app".into())]);
    }

    /// A manifest doc with a namespace carries it (apply/uninstall scope).
    #[test]
    fn manifest_docs_preserve_document_namespaces() {
        let m = "kind: ConfigMap\nmetadata:\n  name: app-config\n  namespace: other\n";
        let docs = manifest_docs(m);
        assert_eq!(docs[0].pointer("/metadata/namespace").and_then(|n| n.as_str()), Some("other"));
    }
}
