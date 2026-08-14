//! Properties (B13, B18): the "what is this thing actually wired to" view — the
//! things you'd otherwise dig out of YAML or several kubectl commands.
//!
//! Rather than a bespoke DTO and renderer per kind, a gatherer returns a generic
//! [`Properties`] document: an ordered list of [`Section`]s, each a field grid, a
//! table, or a set of chips. The frontend renders that shape for every kind, so
//! adding a kind is one gatherer here and nothing there.
//!
//! Every lookup beyond the object itself is best-effort: a missing PVC/PV or an
//! RBAC denial degrades that row or section rather than failing the whole panel.
//!
//! Kinds with a gatherer (see [`gather`]) show the tab; the rest don't.

use super::dto::{Cell, NavTarget, Tone};
use super::helm;
use super::tls;
use crate::error::{AppError, AppResult};
use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::{
    ConfigMap, Event, Node, PersistentVolume, PersistentVolumeClaim, Pod, PodSpec, Secret, Service,
    ServiceAccount,
};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{Ingress, IngressClass};
use k8s_openapi::api::rbac::v1::{
    ClusterRole, ClusterRoleBinding, PolicyRule, Role, RoleBinding, Subject,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::api::{Api, ListParams};
use kube::{Client, ResourceExt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A label/annotation entry (a list keeps frontend rendering simple).
#[derive(Serialize, Clone)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// One row of a field grid: a label, a toned value, and an optional nav target
/// that makes the value a click-through link (B33).
#[derive(Serialize)]
pub struct Field {
    pub label: String,
    pub value: Cell,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav: Option<NavTarget>,
}

impl Field {
    /// Attach a nav target, making this field a link (builder style).
    fn with_nav(mut self, target: NavTarget) -> Self {
        self.nav = Some(target);
        self
    }
}

/// What a section renders as. Tagged so the frontend can switch on `type`.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Body {
    /// A label/value grid (the "Overview" shape).
    Fields { fields: Vec<Field> },
    /// A table. The frontend shows the row count beside the section title.
    Table { columns: Vec<String>, rows: Vec<Vec<Cell>> },
    /// key=value chips (labels/annotations).
    Chips { chips: Vec<KeyValue> },
}

/// One section of the Properties tab.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    /// Shown in place of an empty table ("no taints"). Without one, an empty
    /// table section is dropped entirely (see [`Properties::push_table`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty_note: Option<String>,
    pub body: Body,
}

/// The whole panel: sections in display order.
#[derive(Serialize, Default)]
pub struct Properties {
    pub sections: Vec<Section>,
}

impl Properties {
    fn push(&mut self, section: Section) {
        self.sections.push(section);
    }

    /// Add a field grid.
    fn fields(&mut self, title: &str, fields: Vec<Field>) {
        self.push(Section {
            title: title.into(),
            empty_note: None,
            body: Body::Fields { fields },
        });
    }

    /// Add a table. `empty_note` = Some means an empty table still renders (with
    /// the note); None means an empty table is omitted, so optional sections like
    /// "Other volumes" simply don't appear when there's nothing to show.
    fn push_table(
        &mut self,
        title: &str,
        empty_note: Option<&str>,
        columns: &[&str],
        rows: Vec<Vec<Cell>>,
    ) {
        if rows.is_empty() && empty_note.is_none() {
            return;
        }
        self.push(Section {
            title: title.into(),
            empty_note: empty_note.map(Into::into),
            body: Body::Table {
                columns: columns.iter().map(|c| c.to_string()).collect(),
                rows,
            },
        });
    }

    /// Add a chips section, omitted when empty.
    fn chips(&mut self, title: &str, chips: Vec<KeyValue>) {
        if chips.is_empty() {
            return;
        }
        self.push(Section { title: title.into(), empty_note: None, body: Body::Chips { chips } });
    }
}

/// Placeholder for an unset value (matches the tables' em dash).
const DASH: &str = "—";

fn or_dash(s: Option<String>) -> String {
    s.filter(|v| !v.is_empty()).unwrap_or_else(|| DASH.into())
}

/// A plain secondary-toned cell.
fn c(text: impl Into<String>) -> Cell {
    Cell::new(text.into(), Tone::Secondary)
}

/// A name cell (primary emphasis, matching the tables' NAME column).
fn name_cell(text: impl Into<String>) -> Cell {
    Cell::new(text.into(), Tone::Primary)
}

/// A muted cell (de-emphasized detail).
fn muted(text: impl Into<String>) -> Cell {
    Cell::new(text.into(), Tone::Muted)
}

/// A field with a secondary-toned value.
fn field(label: &str, value: impl Into<String>) -> Field {
    Field { label: label.into(), value: c(value.into()), nav: None }
}

/// A field whose value carries a tone (e.g. a status).
fn field_toned(label: &str, value: impl Into<String>, tone: Tone) -> Field {
    Field { label: label.into(), value: Cell::new(value.into(), tone), nav: None }
}

/// A cell naming another object that may not exist: link it when it does, say so
/// when it doesn't (B42). A link to a 404 is worse than the plain text it
/// replaced, and an absent reference is usually the answer to "why isn't this
/// working" — a missing backend Service is what an Ingress 503 looks like.
fn ref_cell(name: &str, exists: bool, target: NavTarget) -> Cell {
    if name.is_empty() || name == DASH {
        c(DASH)
    } else if exists {
        Cell::link(name.to_string(), Tone::Secondary, Some(target))
    } else {
        Cell::new(format!("{name} (not found)"), Tone::Warn)
    }
}

/// A field that is a click-through link when `nav` is Some (B33).
fn nav_field(label: &str, value: impl Into<String>, nav: Option<NavTarget>) -> Field {
    let f = field(label, value);
    match nav {
        Some(target) => f.with_nav(target),
        None => f,
    }
}

/// Map a built-in Kubernetes Kind (PascalCase) to the app's nav id, for the kinds
/// we list. Returns None for kinds without a table (e.g. ReplicaSet, Endpoints),
/// so an owner of that kind renders as plain text rather than a dead link (B33).
pub fn builtin_nav_id(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "Pod" => "pods",
        "Deployment" => "deployments",
        "ReplicaSet" => "replicasets",
        "StatefulSet" => "statefulsets",
        "DaemonSet" => "daemonsets",
        "Job" => "jobs",
        "CronJob" => "cronjobs",
        "Service" => "services",
        "Ingress" => "ingresses",
        "IngressClass" => "ingressclasses",
        "ConfigMap" => "configmaps",
        "Secret" => "secrets",
        "ServiceAccount" => "serviceaccounts",
        "PersistentVolumeClaim" => "persistentvolumeclaims",
        "PersistentVolume" => "persistentvolumes",
        "StorageClass" => "storageclasses",
        "Node" => "nodes",
        "Namespace" => "namespaces",
        "Role" => "roles",
        "ClusterRole" => "clusterroles",
        "RoleBinding" => "rolebindings",
        "ClusterRoleBinding" => "clusterrolebindings",
        _ => return None,
    })
}

/// Resolve a pod's controller owner into a display string and, where we can
/// navigate to it, a nav target (B33).
///
/// A ReplicaSet owner is resolved *through* to its Deployment — that's the
/// workload the user thinks of as the owner, and it stays the more useful
/// destination even now that ReplicaSets are listed (B40). A bare ReplicaSet (no
/// Deployment above it, or an RBAC-denied lookup) links to the ReplicaSet itself.
pub async fn resolve_owner(client: &Client, namespace: &str, pod: &Pod) -> (String, Option<NavTarget>) {
    let refs = pod.metadata.owner_references.as_ref();
    let owner = refs.and_then(|o| o.iter().find(|r| r.controller == Some(true)).or_else(|| o.first()));
    let Some(owner) = owner else {
        return (DASH.into(), None);
    };

    if owner.kind == "ReplicaSet" {
        let rs_api: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
        if let Ok(rs) = rs_api.get(&owner.name).await {
            if let Some(dep) = rs
                .metadata
                .owner_references
                .as_ref()
                .and_then(|o| o.iter().find(|r| r.kind == "Deployment"))
            {
                return (
                    format!("Deployment/{}", dep.name),
                    Some(NavTarget {
                        kind: "deployments".into(),
                        namespace: Some(namespace.to_string()),
                        name: dep.name.clone(),
                    }),
                );
            }
        }
        // A bare ReplicaSet (no Deployment above it, or the lookup was denied).
        // Since B40 lists ReplicaSets, this is a real destination now rather than
        // the dead end it used to be.
        return (
            format!("ReplicaSet/{}", owner.name),
            Some(NavTarget::namespaced("replicasets", namespace, owner.name.clone())),
        );
    }

    let display = format!("{}/{}", owner.kind, owner.name);
    match builtin_nav_id(&owner.kind) {
        // A Node owner (static/mirror pods) is cluster-scoped; everything else
        // shares the pod's namespace.
        Some(nav) => {
            let namespace = (nav != "nodes").then(|| namespace.to_string());
            (display, Some(NavTarget { kind: nav.into(), namespace, name: owner.name.clone() }))
        }
        None => (display, None),
    }
}

/// Map a BTreeMap of labels/annotations into a KeyValue list (sorted by BTreeMap).
fn to_kv(map: Option<&BTreeMap<String, String>>) -> Vec<KeyValue> {
    map.map(|m| m.iter().map(|(k, v)| KeyValue { key: k.clone(), value: v.clone() }).collect())
        .unwrap_or_default()
}

/// Render a selector map as `k=v,k2=v2` (the form kubectl prints and accepts).
fn selector_text(map: Option<&BTreeMap<String, String>>) -> String {
    match map {
        Some(m) if !m.is_empty() => {
            m.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",")
        }
        _ => DASH.into(),
    }
}

/// A quantity as its original string ("100m", "2Gi"), or a dash.
fn qty(q: Option<&Quantity>) -> String {
    q.map(|q| q.0.clone()).unwrap_or_else(|| DASH.into())
}

/// "n/total" ready-style tone: green when all ready, amber when partial, red at zero.
fn ready_tone(ready: i32, desired: i32) -> Tone {
    if desired == 0 {
        Tone::Muted
    } else if ready >= desired {
        Tone::Good
    } else if ready == 0 {
        Tone::Bad
    } else {
        Tone::Warn
    }
}

/// Tone for a condition's status.
///
/// Most conditions are "good when True" (Ready, Available), but the pressure-style
/// ones invert — a Node with MemoryPressure=True is unhealthy. Getting this wrong
/// would paint a struggling node green, so the polarity is explicit.
fn condition_tone(type_: &str, status: &str) -> Tone {
    let good_when_true = !matches!(
        type_,
        "MemoryPressure"
            | "DiskPressure"
            | "PIDPressure"
            | "NetworkUnavailable"
            | "ReplicaFailure"
    );
    match (status, good_when_true) {
        ("True", true) | ("False", false) => Tone::Good,
        ("False", true) | ("True", false) => Tone::Bad,
        // "Unknown" — the kubelet stopped reporting, or the controller hasn't yet.
        _ => Tone::Warn,
    }
}

/// One condition, flattened from the per-kind condition types (which share these
/// fields but no common trait).
struct Condition {
    type_: String,
    status: String,
    reason: String,
    message: String,
    /// RFC3339 last transition time, if reported.
    since: Option<String>,
}

/// Build the standard Conditions table.
fn conditions_section(props: &mut Properties, conds: Vec<Condition>) {
    let rows = conds
        .into_iter()
        .map(|c0| {
            vec![
                name_cell(c0.type_.clone()),
                Cell::new(c0.status.clone(), condition_tone(&c0.type_, &c0.status)),
                c(c0.reason),
                c(c0.message),
                match c0.since {
                    Some(t) => Cell::age(Some(t)),
                    None => muted(DASH),
                },
            ]
        })
        .collect();
    props.push_table(
        "Conditions",
        Some("no conditions reported"),
        &["TYPE", "STATUS", "REASON", "MESSAGE", "SINCE"],
        rows,
    );
}

/// Labels + annotations, the tail of every kind's panel.
fn meta_sections<K: ResourceExt>(props: &mut Properties, obj: &K) {
    props.chips("Labels", to_kv(obj.meta().labels.as_ref()));
    props.chips("Annotations", to_kv(obj.meta().annotations.as_ref()));
}

/// Gather properties for `kind`. Errors for a kind with no gatherer — the frontend
/// only offers the tab for the kinds listed here (see `KINDS_WITH_PROPERTIES`).
pub async fn gather(
    client: Client,
    kind: &str,
    namespace: &str,
    name: &str,
) -> AppResult<Properties> {
    match kind {
        "pods" => gather_pod(client, namespace, name).await,
        "deployments" => gather_deployment(client, namespace, name).await,
        "services" => gather_service(client, namespace, name).await,
        "statefulsets" => gather_statefulset(client, namespace, name).await,
        "ingresses" => gather_ingress(client, namespace, name).await,
        "nodes" => gather_node(client, name).await,
        "helm" => gather_helm(client, namespace, name).await,
        // B46: the storage kinds and ReplicaSets finally have panels of their own.
        "persistentvolumeclaims" => gather_pvc(client, namespace, name).await,
        "persistentvolumes" => gather_pv(client, namespace, name).await,
        "replicasets" => gather_replicaset(client, namespace, name).await,
        "secrets" => gather_secret(client, namespace, name).await,
        "serviceaccounts" => gather_serviceaccount(client, namespace, name).await,
        "rolebindings" => gather_rolebinding(client, namespace, name).await,
        "clusterrolebindings" => gather_clusterrolebinding(client, name).await,
        other => Err(AppError::Other(format!("no properties for kind {other}"))),
    }
}

// ---------------------------------------------------------------------------
// Ingresses (B43)
// ---------------------------------------------------------------------------

/// An Ingress backend port, which is *either* a number or a named port on the
/// Service — freya's only Ingress uses a name, which is the case a
/// number-only reading would silently drop.
fn backend_port(p: Option<&k8s_openapi::api::networking::v1::ServiceBackendPort>) -> String {
    match p {
        Some(port) => port
            .number
            .map(|n| n.to_string())
            .or_else(|| port.name.clone())
            .unwrap_or_else(|| DASH.into()),
        None => DASH.into(),
    }
}

/// Properties for an Ingress: what it routes, to which Services, over which
/// certificates.
///
/// The routing table is the whole point — an Ingress is a pile of rules pointing
/// at Services, and until now the app showed only HOSTS and CLASS, so the
/// backends were invisible rather than merely unlinked. Every Service and Secret
/// it names is existence-checked, because an Ingress pointing at a Service that
/// isn't there is one of the most common ways this breaks.
async fn gather_ingress(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<Ingress> = Api::namespaced(client.clone(), namespace);
    let ing = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = ing.spec.clone().unwrap_or_default();
    let mut props = Properties::default();

    // Resolve every referenced Service/Secret once, not once per rule: an Ingress
    // routinely points many paths at the same backend.
    let svc_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let sec_api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let mut svc_exists: BTreeMap<String, bool> = BTreeMap::new();
    let mut sec_exists: BTreeMap<String, bool> = BTreeMap::new();

    let backends = spec
        .rules
        .iter()
        .flatten()
        .flat_map(|r| r.http.iter().flat_map(|h| h.paths.iter()))
        .filter_map(|p| p.backend.service.as_ref())
        .chain(spec.default_backend.iter().filter_map(|b| b.service.as_ref()))
        .map(|b| b.name.clone())
        .filter(|n| !n.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    for n in backends {
        let ok = svc_api.get_metadata(&n).await.is_ok();
        svc_exists.insert(n, ok);
    }
    for t in spec.tls.iter().flatten() {
        if let Some(s) = t.secret_name.clone().filter(|s| !s.is_empty()) {
            let ok = sec_api.get_metadata(&s).await.is_ok();
            sec_exists.insert(s, ok);
        }
    }

    // ---- overview ----
    let class = spec.ingress_class_name.clone().unwrap_or_else(|| DASH.into());
    let default_backend = spec
        .default_backend
        .as_ref()
        .and_then(|b| b.service.as_ref())
        .map(|b| b.name.clone())
        .unwrap_or_else(|| DASH.into());
    // Where the controller is actually answering, from status.
    let address = ing
        .status
        .as_ref()
        .and_then(|s| s.load_balancer.as_ref())
        .and_then(|lb| lb.ingress.as_ref())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.ip.clone().or_else(|| i.hostname.clone()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| DASH.into());

    // The class links only when it actually exists. An Ingress referencing a
    // class that isn't installed — a missing ingress controller — is exactly the
    // "why is nothing routing" case, and linking to a 404 would hide it.
    let class_exists = class == DASH || {
        let api: Api<IngressClass> = Api::all(client.clone());
        api.get_metadata(&class).await.is_ok()
    };
    let class_cell = if class == DASH {
        muted(DASH)
    } else if class_exists {
        Cell::link(class.clone(), Tone::Secondary, Some(NavTarget::cluster("ingressclasses", class.clone())))
    } else {
        Cell::new(format!("{class} (not found)"), Tone::Warn)
    };

    props.fields(
        "Overview",
        vec![
            Field { label: "class".into(), value: class_cell, nav: None },
            nav_field(
                "default backend",
                default_backend.clone(),
                (default_backend != DASH)
                    .then(|| NavTarget::namespaced("services", namespace, default_backend.clone())),
            ),
            field("address", address),
        ],
    );

    // ---- rules ----
    let mut rule_rows: Vec<Vec<Cell>> = Vec::new();
    for rule in spec.rules.iter().flatten() {
        // No host is a catch-all, which kubectl prints as "*".
        let host = rule.host.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| "*".into());
        for path in rule.http.iter().flat_map(|h| h.paths.iter()) {
            let svc = path.backend.service.as_ref();
            let svc_name = svc.map(|b| b.name.clone()).unwrap_or_else(|| DASH.into());
            let exists = svc_exists.get(&svc_name).copied().unwrap_or(false);
            rule_rows.push(vec![
                name_cell(host.clone()),
                c(path.path.clone().unwrap_or_else(|| "/".into())),
                c(path.path_type.clone()),
                ref_cell(
                    &svc_name,
                    exists,
                    NavTarget::namespaced("services", namespace, svc_name.clone()),
                ),
                c(backend_port(svc.and_then(|b| b.port.as_ref()))),
            ]);
        }
    }
    props.push_table(
        "Rules",
        Some("no rules — this Ingress routes nothing"),
        &["HOST", "PATH", "PATH TYPE", "SERVICE", "PORT"],
        rule_rows,
    );

    // ---- tls ----
    let mut tls_rows: Vec<Vec<Cell>> = Vec::new();
    for t in spec.tls.iter().flatten() {
        let secret = t.secret_name.clone().unwrap_or_else(|| DASH.into());
        let exists = sec_exists.get(&secret).copied().unwrap_or(false);
        let mut cell = ref_cell(
            &secret,
            exists,
            NavTarget::namespaced("secrets", namespace, secret.clone()),
        );
        // An expiring cert is worth seeing from the routing side: tone the
        // SECRET link with the cert's notAfter tone (B48).
        if exists && secret != DASH {
            if let Some(tone) = secret_cert_tone(&sec_api, &secret).await {
                cell.tone = tone;
            }
        }
        tls_rows.push(vec![
            name_cell(
                t.hosts
                    .as_ref()
                    .map(|h| h.join(", "))
                    .filter(|h| !h.is_empty())
                    .unwrap_or_else(|| "*".into()),
            ),
            cell,
        ]);
    }
    props.push_table("TLS", Some("no TLS — served over HTTP"), &["HOSTS", "SECRET"], tls_rows);

    meta_sections(&mut props, &ing);
    Ok(props)
}

// ---------------------------------------------------------------------------
// Helm releases (B35)
// ---------------------------------------------------------------------------

/// Properties for a Helm release: an Overview, the full revision History, and the
/// user-supplied Values.
///
/// Every revision is its own `helm.sh/release.v1` Secret (B26). Where the table
/// keeps only the newest via `latest_only`, this is the inverse view: it decodes
/// *all* of a release's revision Secrets — found by Helm's own `owner=helm,name=…`
/// labels — to reconstruct the history. Still zero writes.
async fn gather_helm(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<Secret> = Api::namespaced(client, namespace);
    // Helm labels every release Secret with owner + release name; filtering here
    // avoids decoding every Secret in the namespace.
    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let secrets = api.list(&lp).await.map_err(|e| AppError::Kube(e.to_string()))?;

    let releases: Vec<helm::Release> =
        secrets.items.iter().filter_map(helm::decode_release).collect();
    if releases.is_empty() {
        return Err(AppError::NotFound(format!("no Helm release {name} in {namespace}")));
    }
    Ok(build_helm_properties(releases))
}

/// Kind/name pairs of the objects a release's rendered manifest installs (B46).
///
/// The manifest is a sequence of YAML documents; each document's top-level
/// `kind` and `metadata.name` are what we list. Parsed from the document, not by
/// a schema: a Helm chart can install any object, including CRDs we don't model.
fn manifest_objects(manifest: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for doc in serde_yaml::Deserializer::from_str(manifest) {
        let Ok(value) = serde_yaml::Value::deserialize(doc) else {
            continue; // a stray `---` or an unparsable doc is not a failure
        };
        let Some(kind) = value.get("kind").and_then(|v| v.as_str()).map(String::from) else {
            continue;
        };
        let name = value
            .get("metadata")
            .and_then(|m| m.get("name"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_default();
        if !kind.is_empty() && !name.is_empty() {
            out.push((kind, name));
        }
    }
    out
}

/// Build the release document from its decoded revisions (pure, so the ordering
/// and toning are testable without a cluster). Newest revision leads the Overview
/// and the History.
fn build_helm_properties(mut releases: Vec<helm::Release>) -> Properties {
    // Newest revision first — the current release leads, history follows.
    releases.sort_by_key(|r| std::cmp::Reverse(r.revision));
    let current = &releases[0];

    let mut props = Properties::default();

    // ---- overview (from the current revision) ----
    props.fields(
        "Overview",
        vec![
            field("chart", current.chart.clone()),
            field("app version", current.app_version.clone()),
            field_toned("status", current.status.clone(), helm::status_tone(&current.status)),
            field("revision", current.revision.to_string()),
            Field {
                label: "first deployed".into(),
                value: Cell::age(Some(current.first_deployed.clone()).filter(|s| !s.is_empty())),
                nav: None,
            },
            Field {
                label: "last deployed".into(),
                value: Cell::age(Some(current.updated.clone()).filter(|s| !s.is_empty())),
                nav: None,
            },
            field("description", current.description.clone()),
        ],
    );

    // ---- history (every revision, newest first) ----
    let rows: Vec<Vec<Cell>> = releases
        .iter()
        .map(|r| {
            vec![
                name_cell(r.revision.to_string()),
                Cell::status(r.status.clone(), helm::status_tone(&r.status)),
                c(r.chart.clone()),
                c(r.description.clone()),
                Cell::age(Some(r.updated.clone()).filter(|s| !s.is_empty())),
            ]
        })
        .collect();
    props.push_table(
        "History",
        Some("no revisions"),
        &["REVISION", "STATUS", "CHART", "DESCRIPTION", "UPDATED"],
        rows,
    );

    // ---- values (user overrides, redacted, flattened) ----
    let value_rows: Vec<Vec<Cell>> = helm::flatten_values(&current.config)
        .into_iter()
        .map(|(k, v)| vec![name_cell(k), c(v)])
        .collect();
    props.push_table(
        "Values",
        // An empty config isn't missing data — the release runs on the chart's
        // own defaults, which is worth saying rather than showing a blank table.
        Some("chart defaults (no overrides)"),
        &["KEY", "VALUE"],
        value_rows,
    );

    // ---- objects the release installed (B46) ----
    // Each is a link when the kind is one we list; a CRD kind we don't model
    // renders as plain text rather than a dead link.
    let obj_rows: Vec<Vec<Cell>> = manifest_objects(&current.manifest)
        .into_iter()
        .map(|(kind, name)| {
            let nav = builtin_nav_id(&kind)
                .map(|nav| NavTarget::namespaced(nav, current.namespace.clone(), name.clone()));
            vec![name_cell(kind), Cell::link(name, Tone::Secondary, nav)]
        })
        .collect();
    props.push_table(
        "Objects",
        Some("nothing in the manifest"),
        &["KIND", "NAME"],
        obj_rows,
    );

    props
}

// ---------------------------------------------------------------------------
// Pods (B13)
// ---------------------------------------------------------------------------

async fn gather_pod(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = pods.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;

    let spec = pod.spec.clone().unwrap_or_default();
    let status = pod.status.clone().unwrap_or_default();
    let mut props = Properties::default();

    // ---- overview ----
    // The owner is a click-through link (B33); a ReplicaSet owner resolves through
    // to its Deployment, since that's the workload the user means and we don't list
    // ReplicaSets as a kind.
    let (owner_text, owner_nav) = resolve_owner(&client, namespace, &pod).await;

    props.fields(
        "Overview",
        vec![
            nav_field(
                "node",
                or_dash(spec.node_name.clone()),
                // Nodes are cluster-scoped, so no namespace on the target.
                spec.node_name.clone().filter(|n| !n.is_empty()).map(|n| NavTarget::cluster("nodes", n)),
            ),
            field("pod IP", or_dash(status.pod_ip.clone())),
            field("host IP", or_dash(status.host_ip.clone())),
            field("QoS", or_dash(status.qos_class.clone())),
            nav_field("owner", owner_text, owner_nav),
            nav_field(
                "service account",
                or_dash(spec.service_account_name.clone()),
                spec.service_account_name
                    .clone()
                    .filter(|s| !s.is_empty())
                    .map(|s| NavTarget::namespaced("serviceaccounts", namespace, s)),
            ),
            field("restart policy", or_dash(spec.restart_policy.clone())),
            field("priority class", or_dash(spec.priority_class_name.clone())),
            Field {
                label: "started".into(),
                value: match status.start_time.as_ref() {
                    Some(t) => Cell::age(Some(t.0.to_rfc3339())),
                    None => muted(DASH),
                },
                nav: None,
            },
        ],
    );

    // ---- containers ----
    let statuses = status.container_statuses.clone().unwrap_or_default();
    let rows = spec
        .containers
        .iter()
        .map(|ct| {
            let cs = statuses.iter().find(|s| s.name == ct.name);
            let state = cs
                .and_then(|s| s.state.as_ref())
                .map(|st| {
                    if st.running.is_some() {
                        "Running".to_string()
                    } else if let Some(w) = &st.waiting {
                        format!("Waiting: {}", w.reason.clone().unwrap_or_default())
                    } else if let Some(t) = &st.terminated {
                        format!("Terminated: {}", t.reason.clone().unwrap_or_default())
                    } else {
                        "Unknown".to_string()
                    }
                })
                .unwrap_or_else(|| "Unknown".into());
            let state_tone = if state.starts_with("Running") {
                Tone::Good
            } else if state.starts_with("Waiting") {
                Tone::Warn
            } else if state.starts_with("Terminated") {
                Tone::Bad
            } else {
                Tone::Secondary
            };

            // "request / limit" per resource.
            let (cpu, memory) = match &ct.resources {
                Some(r) => {
                    let fmt = |key: &str| {
                        let req = r.requests.as_ref().and_then(|m| m.get(key)).map(|q| q.0.clone());
                        let lim = r.limits.as_ref().and_then(|m| m.get(key)).map(|q| q.0.clone());
                        match (&req, &lim) {
                            (None, None) => DASH.to_string(),
                            _ => format!(
                                "{} / {}",
                                req.unwrap_or_else(|| DASH.into()),
                                lim.unwrap_or_else(|| DASH.into())
                            ),
                        }
                    };
                    (fmt("cpu"), fmt("memory"))
                }
                None => (DASH.to_string(), DASH.to_string()),
            };

            let ports = ct
                .ports
                .as_ref()
                .map(|ps| {
                    ps.iter()
                        .map(|p| {
                            format!(
                                "{}/{}",
                                p.container_port,
                                p.protocol.clone().unwrap_or_else(|| "TCP".into())
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DASH.into());

            let ready = cs.map(|s| s.ready).unwrap_or(false);
            let restarts = cs.map(|s| s.restart_count).unwrap_or(0);
            vec![
                name_cell(ct.name.clone()),
                c(ct.image.clone().unwrap_or_else(|| DASH.into())),
                Cell::new(state, state_tone),
                Cell::new(if ready { "yes" } else { "no" }, if ready { Tone::Good } else { Tone::Warn }),
                Cell::new(
                    restarts.to_string(),
                    if restarts > 5 { Tone::Bad } else { Tone::Secondary },
                ),
                c(cpu),
                c(memory),
                c(ports),
            ]
        })
        .collect();
    props.push_table(
        "Containers",
        Some("no containers"),
        &["NAME", "IMAGE", "STATE", "READY", "RESTARTS", "CPU R/L", "MEM R/L", "PORTS"],
        rows,
    );

    // ---- volumes (resolving PVC → PV) ----
    let volumes = gather_volumes(&client, namespace, &spec).await;
    let (pvc_vols, other_vols): (Vec<_>, Vec<_>) = volumes.into_iter().partition(|v| v.kind == "PVC");

    props.push_table(
        "Storage",
        Some("no persistent volumes attached"),
        &["VOLUME", "CLAIM", "PV", "CAPACITY", "CLASS", "ACCESS", "PHASE", "MOUNTED AT"],
        pvc_vols
            .iter()
            .map(|v| {
                vec![
                    name_cell(v.name.clone()),
                    // The claim, its volume and its class are all listed kinds
                    // now, so each cell links through (B40). `Cell::link` drops
                    // the link when the value is an em dash — an unbound claim
                    // has no PV to go to.
                    Cell::link(
                        v.claim.clone(),
                        Tone::Secondary,
                        Some(NavTarget::namespaced("persistentvolumeclaims", namespace, v.claim.clone())),
                    ),
                    Cell::link(
                        v.pv.clone(),
                        Tone::Secondary,
                        Some(NavTarget::cluster("persistentvolumes", v.pv.clone())),
                    ),
                    c(v.capacity.clone()),
                    Cell::link(
                        v.storage_class.clone(),
                        Tone::Secondary,
                        Some(NavTarget::cluster("storageclasses", v.storage_class.clone())),
                    ),
                    c(v.access_modes.clone()),
                    Cell::new(
                        v.phase.clone(),
                        if v.phase == "Bound" { Tone::Good } else { Tone::Warn },
                    ),
                    c(mount_text(v)),
                ]
            })
            .collect(),
    );

    // ---- services selecting this pod ----
    let services = gather_services(&client, namespace, pod.metadata.labels.as_ref()).await;
    props.push_table(
        "Services",
        Some("no services select this pod"),
        &["NAME", "TYPE", "CLUSTER-IP", "PORTS"],
        services,
    );

    // Config/secret/projected volumes: interesting, but not worth a section of
    // their own when there are none.
    props.push_table(
        "Other volumes",
        None,
        &["VOLUME", "KIND", "SOURCE", "MOUNTED AT"],
        other_vols
            .iter()
            .map(|v| {
                vec![
                    name_cell(v.name.clone()),
                    c(v.kind.clone()),
                    if v.source_missing {
                        // The mount is empty; that's the answer to "why is this
                        // config not applying", so it's worth colouring.
                        Cell::new(format!("{} (not found)", v.source), Tone::Warn)
                    } else {
                        Cell::link(v.source.clone(), Tone::Secondary, v.source_nav.clone())
                    },
                    c(mount_text(v)),
                ]
            })
            .collect(),
    );

    // ---- references: image pull secrets + env/envFrom sources (B46) ----
    let refs = pod_references(&client, namespace, &pod).await;
    props.push_table(
        "References",
        Some("no image pull secrets or env/envFrom ConfigMap/Secret refs"),
        &["TYPE", "OBJECT", "KEY", "USED BY"],
        refs,
    );

    meta_sections(&mut props, &pod);
    Ok(props)
}

/// A volume attached to a pod; PVC-backed ones carry resolved claim/PV details.
struct VolumeInfo {
    name: String,
    kind: String,
    mount_paths: String,
    read_only: bool,
    claim: String,
    pv: String,
    capacity: String,
    storage_class: String,
    access_modes: String,
    phase: String,
    /// For a ConfigMap/Secret-backed volume, the object it mounts, and a link to
    /// it. The classification alone ("Secret") doesn't say *which* Secret, which
    /// is the thing you opened the panel to find out.
    source: String,
    source_nav: Option<NavTarget>,
    /// The referenced ConfigMap/Secret doesn't exist. Legal — a volume source can
    /// be `optional: true` — but worth saying, because the mount is then empty.
    source_missing: bool,
}

/// "/data, /var/lib (ro)".
fn mount_text(v: &VolumeInfo) -> String {
    if v.read_only {
        format!("{} (ro)", v.mount_paths)
    } else {
        v.mount_paths.clone()
    }
}

/// Build the volume list, resolving PVC → PV where possible (best-effort).
/// The pod's references to ConfigMaps and Secrets — image pull secrets and the
/// env/envFrom sources on its containers — as a table's rows (B46). Each is
/// existence-checked and links to the object when it exists, following
/// `ref_cell`'s "a link to a 404 is worse than the plain text it replaced" rule
/// (an `optional: true` source may legitimately be absent).
/// Collect (type, object name, key, used-by) references from a pod spec: image
/// pull secrets and the env/envFrom ConfigMap/Secret sources (B46). Pure, so
/// the row shape is pinned by a test. Key is "—" for whole-object sources.
fn collect_pod_refs(spec: &PodSpec) -> Vec<(&'static str, String, String, String)> {
    let mut refs = Vec::new();
    for s in spec.image_pull_secrets.iter().flatten() {
        refs.push(("image pull secret", s.name.clone(), DASH.into(), "pod".into()));
    }
    for ct in &spec.containers {
        let used = ct.name.clone();
        for e in ct.env.iter().flatten() {
            if let Some(vf) = &e.value_from {
                if let Some(cr) = &vf.config_map_key_ref {
                    refs.push(("ConfigMap (env)", cr.name.clone(), or_dash(Some(cr.key.clone())), used.clone()));
                }
                if let Some(sr) = &vf.secret_key_ref {
                    refs.push(("Secret (env)", sr.name.clone(), or_dash(Some(sr.key.clone())), used.clone()));
                }
            }
        }
        for e in ct.env_from.iter().flatten() {
            if let Some(cm) = &e.config_map_ref {
                refs.push(("ConfigMap (envFrom)", cm.name.clone(), DASH.into(), used.clone()));
            }
            if let Some(sr) = &e.secret_ref {
                refs.push(("Secret (envFrom)", sr.name.clone(), DASH.into(), used.clone()));
            }
        }
    }
    refs
}

async fn pod_references(client: &Client, namespace: &str, pod: &Pod) -> Vec<Vec<Cell>> {
    let spec = pod.spec.clone().unwrap_or_default();
    let refs = collect_pod_refs(&spec);
    if refs.is_empty() {
        return Vec::new();
    }

    // Existence-check each referenced object once (get_metadata: never pull a
    // Secret's contents for a yes/no).
    let cm_api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    let sec_api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let mut cm_exists: BTreeMap<String, bool> = BTreeMap::new();
    let mut sec_exists: BTreeMap<String, bool> = BTreeMap::new();

    let refs: Vec<_> = refs
        .into_iter()
        .filter(|(_, name, _, _)| !name.is_empty() && name != DASH)
        .collect();

    let mut rows = Vec::with_capacity(refs.len());
    for (kind, name, key, used) in refs {
        let is_secret = kind.starts_with("Secret");
        let exists = if is_secret {
            let slot = sec_exists.entry(name.clone()).or_insert(false);
            if !*slot {
                *slot = sec_api.get_metadata(&name).await.is_ok();
            }
            *slot
        } else {
            let slot = cm_exists.entry(name.clone()).or_insert(false);
            if !*slot {
                *slot = cm_api.get_metadata(&name).await.is_ok();
            }
            *slot
        };
        let target = NavTarget::namespaced(
            if is_secret { "secrets" } else { "configmaps" },
            namespace,
            name.clone(),
        );
        rows.push(vec![c(kind.to_string()), ref_cell(&name, exists, target), c(key), c(used)]);
    }
    rows
}

async fn gather_volumes(
    client: &Client,
    namespace: &str,
    spec: &k8s_openapi::api::core::v1::PodSpec,
) -> Vec<VolumeInfo> {
    let pvcs: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
    let pvs: Api<PersistentVolume> = Api::all(client.clone());

    let mut out = Vec::new();
    for v in spec.volumes.iter().flatten() {
        // Where do containers mount this volume?
        let mut mounts: Vec<String> = Vec::new();
        let mut read_only = false;
        for ct in &spec.containers {
            for m in ct.volume_mounts.iter().flatten() {
                if m.name == v.name {
                    mounts.push(m.mount_path.clone());
                    read_only |= m.read_only.unwrap_or(false);
                }
            }
        }
        let mount_paths = if mounts.is_empty() { DASH.to_string() } else { mounts.join(", ") };

        let (source, source_nav) = volume_source(v, namespace);
        let mut info = VolumeInfo {
            name: v.name.clone(),
            kind: volume_kind(v).to_string(),
            mount_paths,
            read_only,
            claim: String::new(),
            pv: String::new(),
            capacity: String::new(),
            storage_class: String::new(),
            access_modes: String::new(),
            phase: String::new(),
            source,
            source_nav,
            source_missing: false,
        };

        // A volume source may be `optional: true` and simply not exist (Argo's
        // repo-server declares a TLS Secret that's only created if you enable
        // TLS). Linking to it would be a link to a 404 — worse than the plain
        // text it replaced — so confirm it's there first. `get_metadata` is used
        // deliberately: an existence check must not pull a Secret's contents.
        if let Some(nav) = info.source_nav.clone() {
            let exists = match nav.kind.as_str() {
                "configmaps" => {
                    let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
                    api.get_metadata(&nav.name).await.is_ok()
                }
                "secrets" => {
                    let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
                    api.get_metadata(&nav.name).await.is_ok()
                }
                _ => true,
            };
            if !exists {
                info.source_missing = true;
                info.source_nav = None;
            }
        }

        // Resolve PVC-backed volumes.
        if let Some(src) = &v.persistent_volume_claim {
            info.claim = src.claim_name.clone();
            if let Ok(pvc) = pvcs.get(&src.claim_name).await {
                let pvc_spec = pvc.spec.clone().unwrap_or_default();
                let pvc_status = pvc.status.clone().unwrap_or_default();
                info.phase = or_dash(pvc_status.phase.clone());
                info.storage_class = or_dash(pvc_spec.storage_class_name.clone());
                info.access_modes = pvc_spec
                    .access_modes
                    .map(|a| a.join(", "))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| DASH.into());
                // Capacity: prefer the bound status, fall back to the request.
                info.capacity = pvc_status
                    .capacity
                    .as_ref()
                    .and_then(|cap| cap.get("storage"))
                    .map(|q| q.0.clone())
                    .or_else(|| {
                        pvc_spec
                            .resources
                            .as_ref()
                            .and_then(|r| r.requests.as_ref())
                            .and_then(|r| r.get("storage"))
                            .map(|q| q.0.clone())
                    })
                    .unwrap_or_else(|| DASH.into());
                // Bound PV.
                if let Some(pv_name) = pvc_spec.volume_name.filter(|n| !n.is_empty()) {
                    info.pv = pv_name.clone();
                    // PV capacity is authoritative when present.
                    if let Ok(pv) = pvs.get(&pv_name).await {
                        if let Some(cap) = pv
                            .spec
                            .as_ref()
                            .and_then(|s| s.capacity.as_ref())
                            .and_then(|cap| cap.get("storage"))
                        {
                            info.capacity = cap.0.clone();
                        }
                    }
                } else {
                    info.pv = DASH.into();
                }
            } else {
                // PVC unreadable (deleted or RBAC): show what we know.
                info.phase = DASH.into();
                info.pv = DASH.into();
                info.capacity = DASH.into();
                info.storage_class = DASH.into();
                info.access_modes = DASH.into();
            }
        }

        out.push(info);
    }
    out
}

/// The source detail behind a volume: *which* object, host path, or NFS export it
/// mounts. `volume_kind` only classifies ("ConfigMap", "HostPath", "NFS"), which
/// leaves the panel saying a pod mounts *a* HostPath without saying which — and
/// that path is the thing you opened the panel to find.
///
/// ConfigMap/Secret sources are listed kinds, so they link through (B40); the rest
/// (a host directory, an NFS server, a CSI driver) aren't cluster objects, so they
/// are shown as plain text with no nav target.
fn volume_source(
    v: &k8s_openapi::api::core::v1::Volume,
    namespace: &str,
) -> (String, Option<NavTarget>) {
    if let Some(name) = v
        .config_map
        .as_ref()
        .map(|cm| cm.name.clone())
        .filter(|n| !n.is_empty())
    {
        let nav = NavTarget::namespaced("configmaps", namespace, name.clone());
        return (name, Some(nav));
    }
    if let Some(name) = v
        .secret
        .as_ref()
        .and_then(|s| s.secret_name.clone())
        .filter(|n| !n.is_empty())
    {
        let nav = NavTarget::namespaced("secrets", namespace, name.clone());
        return (name, Some(nav));
    }
    // A hostPath mounts a directory on the node — the path is the whole point.
    if let Some(hp) = v.host_path.as_ref().filter(|hp| !hp.path.is_empty()) {
        return (hp.path.clone(), None);
    }
    // An NFS mount is identified by "server:/export", as `mount` writes it.
    if let Some(nfs) = v.nfs.as_ref() {
        if !nfs.server.is_empty() || !nfs.path.is_empty() {
            return (format!("{}:{}", nfs.server, nfs.path), None);
        }
    }
    // A CSI ephemeral volume: the driver is what says who backs it.
    if let Some(csi) = v.csi.as_ref().filter(|csi| !csi.driver.is_empty()) {
        return (csi.driver.clone(), None);
    }
    (DASH.to_string(), None)
}

/// Classify a volume by its source.
fn volume_kind(v: &k8s_openapi::api::core::v1::Volume) -> &'static str {
    if v.persistent_volume_claim.is_some() {
        "PVC"
    } else if v.config_map.is_some() {
        "ConfigMap"
    } else if v.secret.is_some() {
        "Secret"
    } else if v.empty_dir.is_some() {
        "EmptyDir"
    } else if v.host_path.is_some() {
        "HostPath"
    } else if v.projected.is_some() {
        "Projected"
    } else if v.downward_api.is_some() {
        "DownwardAPI"
    } else if v.nfs.is_some() {
        "NFS"
    } else if v.csi.is_some() {
        "CSI"
    } else {
        "Other"
    }
}

/// Services in the namespace whose selector matches the pod's labels.
async fn gather_services(
    client: &Client,
    namespace: &str,
    pod_labels: Option<&BTreeMap<String, String>>,
) -> Vec<Vec<Cell>> {
    let Some(labels) = pod_labels else {
        return Vec::new();
    };
    let svcs: Api<Service> = Api::namespaced(client.clone(), namespace);
    let list = match svcs.list(&ListParams::default()).await {
        Ok(l) => l,
        Err(_) => return Vec::new(), // RBAC or transient: degrade to empty
    };

    list.items
        .into_iter()
        .filter_map(|s| {
            let spec = s.spec.as_ref()?;
            let selector = spec.selector.as_ref()?;
            // A service selects this pod when every selector entry matches a label.
            if selector.is_empty()
                || !selector.iter().all(|(k, v)| labels.get(k).map(|lv| lv == v).unwrap_or(false))
            {
                return None;
            }
            let name = s.metadata.name.clone().unwrap_or_default();
            Some(vec![
                Cell::link(
                    name.clone(),
                    Tone::Primary,
                    Some(NavTarget::namespaced("services", namespace, name)),
                ),
                c(spec.type_.clone().unwrap_or_else(|| "ClusterIP".into())),
                c(or_dash(spec.cluster_ip.clone())),
                c(service_ports_text(spec)),
            ])
        })
        .collect()
}

/// "8080/TCP, 443/TCP" for a service spec.
fn service_ports_text(spec: &k8s_openapi::api::core::v1::ServiceSpec) -> String {
    spec.ports
        .as_ref()
        .map(|ps| {
            ps.iter()
                .map(|p| format!("{}/{}", p.port, p.protocol.clone().unwrap_or_else(|| "TCP".into())))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| DASH.into())
}

// ---------------------------------------------------------------------------
// Deployments (B18)
// ---------------------------------------------------------------------------

async fn gather_deployment(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let dep = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = dep.spec.clone().unwrap_or_default();
    let status = dep.status.clone().unwrap_or_default();
    let mut props = Properties::default();

    let desired = spec.replicas.unwrap_or(1);
    let ready = status.ready_replicas.unwrap_or(0);

    // Rollout strategy, with the surge/unavailable knobs that actually govern it.
    let strategy = spec
        .strategy
        .as_ref()
        .map(|s| {
            let type_ = s.type_.clone().unwrap_or_else(|| "RollingUpdate".into());
            match &s.rolling_update {
                Some(ru) => {
                    let surge = ru.max_surge.as_ref().map(int_or_string).unwrap_or_else(|| "—".into());
                    let unavail =
                        ru.max_unavailable.as_ref().map(int_or_string).unwrap_or_else(|| "—".into());
                    format!("{type_} (max surge {surge}, max unavailable {unavail})")
                }
                None => type_,
            }
        })
        .unwrap_or_else(|| DASH.into());

    props.fields(
        "Overview",
        vec![
            field_toned("replicas", format!("{ready}/{desired} ready"), ready_tone(ready, desired)),
            field("up-to-date", status.updated_replicas.unwrap_or(0).to_string()),
            field("available", status.available_replicas.unwrap_or(0).to_string()),
            field_toned(
                "unavailable",
                status.unavailable_replicas.unwrap_or(0).to_string(),
                if status.unavailable_replicas.unwrap_or(0) > 0 { Tone::Warn } else { Tone::Secondary },
            ),
            field("strategy", strategy),
            field("selector", selector_text(spec.selector.match_labels.as_ref())),
            field("generation", dep.metadata.generation.unwrap_or(0).to_string()),
            field_toned(
                "paused",
                if spec.paused.unwrap_or(false) { "yes" } else { "no" },
                if spec.paused.unwrap_or(false) { Tone::Warn } else { Tone::Secondary },
            ),
        ],
    );

    // ---- owned ReplicaSets ----
    // Ownership is by uid, not name: a deleted-and-recreated Deployment reuses the
    // name, and matching on it would adopt the old generation's ReplicaSets.
    let owned = owned_replicasets(&client, namespace, dep.metadata.uid.as_deref().unwrap_or_default()).await;
    let rs_rows = owned
        .iter()
        .map(|rs| {
            let s = rs.status.clone().unwrap_or_default();
            let want = rs.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
            let rs_ready = s.ready_replicas.unwrap_or(0);
            vec![
                // ReplicaSets are a listed kind now (B40), so a revision
                // row opens the generation it names.
                Cell::link(
                    rs.name_any(),
                    Tone::Primary,
                    Some(NavTarget::namespaced("replicasets", namespace, rs.name_any())),
                ),
                c(revision_of(rs).map(|r| r.to_string()).unwrap_or_else(|| DASH.into())),
                c(want.to_string()),
                c(s.replicas.to_string()),
                Cell::new(rs_ready.to_string(), ready_tone(rs_ready, want)),
                Cell::age(rs.creation_timestamp().map(|t| t.0.to_rfc3339())),
            ]
        })
        .collect();
    props.push_table(
        "ReplicaSets",
        Some("no replica sets (or none readable)"),
        &["NAME", "REVISION", "DESIRED", "CURRENT", "READY", "AGE"],
        rs_rows,
    );

    conditions_section(
        &mut props,
        status
            .conditions
            .unwrap_or_default()
            .into_iter()
            .map(|cd| Condition {
                type_: cd.type_,
                status: cd.status,
                reason: or_dash(cd.reason),
                message: or_dash(cd.message),
                since: cd.last_transition_time.map(|t| t.0.to_rfc3339()),
            })
            .collect(),
    );

    meta_sections(&mut props, &dep);
    Ok(props)
}

/// A ReplicaSet's rollout revision, from the annotation the Deployment controller
/// stamps on it. Shared with rollout undo (B34b), which resolves a ReplicaSet by
/// the same revision the properties panel shows.
pub(crate) fn revision_of(rs: &ReplicaSet) -> Option<i64> {
    rs.metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("deployment.kubernetes.io/revision"))
        .and_then(|v| v.parse().ok())
}

/// A Deployment's owned ReplicaSets (matched by owner *uid*, not name — a
/// deleted-and-recreated Deployment reuses its name, and matching on it would
/// adopt the old generation's ReplicaSets), newest revision first. Shared by the
/// properties panel and rollout undo (B34b).
pub(crate) async fn owned_replicasets(
    client: &Client,
    namespace: &str,
    uid: &str,
) -> Vec<ReplicaSet> {
    match Api::<ReplicaSet>::namespaced(client.clone(), namespace)
        .list(&ListParams::default())
        .await
    {
        Ok(list) => {
            let mut owned: Vec<ReplicaSet> = list
                .items
                .into_iter()
                .filter(|rs| {
                    rs.metadata
                        .owner_references
                        .iter()
                        .flatten()
                        .any(|o| o.uid.as_str() == uid)
                })
                .collect();
            // Newest revision first — that's the one being rolled out.
            owned.sort_by_key(|rs| std::cmp::Reverse(revision_of(rs)));
            owned
        }
        Err(_) => Vec::new(), // RBAC/transient: degrade to an empty list
    }
}

/// Render an IntOrString ("25%" or "1").
fn int_or_string(v: &k8s_openapi::apimachinery::pkg::util::intstr::IntOrString) -> String {
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
    match v {
        IntOrString::Int(i) => i.to_string(),
        IntOrString::String(s) => s.clone(),
    }
}

// ---------------------------------------------------------------------------
// Services (B18)
// ---------------------------------------------------------------------------

async fn gather_service(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let svc = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = svc.spec.clone().unwrap_or_default();
    let mut props = Properties::default();

    // LoadBalancer ingress addresses, once assigned.
    let lb = svc
        .status
        .as_ref()
        .and_then(|s| s.load_balancer.as_ref())
        .and_then(|lb| lb.ingress.as_ref())
        .map(|ing| {
            ing.iter()
                .filter_map(|i| i.ip.clone().or_else(|| i.hostname.clone()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DASH.into());

    props.fields(
        "Overview",
        vec![
            field("type", spec.type_.clone().unwrap_or_else(|| "ClusterIP".into())),
            field("cluster IP", or_dash(spec.cluster_ip.clone())),
            field("load balancer", lb),
            field(
                "external IPs",
                spec.external_ips
                    .as_ref()
                    .map(|v| v.join(", "))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| DASH.into()),
            ),
            field("selector", selector_text(spec.selector.as_ref())),
            field("session affinity", or_dash(spec.session_affinity.clone())),
            field("traffic policy", or_dash(spec.external_traffic_policy.clone())),
        ],
    );

    // ---- ports ----
    props.push_table(
        "Ports",
        Some("no ports"),
        &["NAME", "PORT", "TARGET", "NODE PORT", "PROTOCOL"],
        spec.ports
            .iter()
            .flatten()
            .map(|p| {
                vec![
                    name_cell(p.name.clone().unwrap_or_else(|| DASH.into())),
                    c(p.port.to_string()),
                    c(p.target_port.as_ref().map(int_or_string).unwrap_or_else(|| p.port.to_string())),
                    c(p.node_port.map(|n| n.to_string()).unwrap_or_else(|| DASH.into())),
                    c(p.protocol.clone().unwrap_or_else(|| "TCP".into())),
                ]
            })
            .collect(),
    );

    // ---- endpoints ----
    // EndpointSlices, not the legacy Endpoints object: slices are what modern
    // clusters actually populate, and they carry the target pod and node.
    let slices = Api::<EndpointSlice>::namespaced(client, namespace)
        .list(&ListParams::default().labels(&format!("kubernetes.io/service-name={name}")))
        .await;
    let mut ep_rows: Vec<Vec<Cell>> = Vec::new();
    if let Ok(list) = slices {
        for slice in list.items {
            for ep in slice.endpoints {
                let ready = ep.conditions.as_ref().and_then(|c0| c0.ready).unwrap_or(true);
                let target = ep
                    .target_ref
                    .as_ref()
                    .and_then(|t| t.name.clone())
                    .unwrap_or_else(|| DASH.into());
                let node = ep.node_name.clone().unwrap_or_else(|| DASH.into());
                for addr in &ep.addresses {
                    ep_rows.push(vec![
                        name_cell(addr.clone()),
                        Cell::new(
                            if ready { "ready" } else { "not ready" },
                            if ready { Tone::Good } else { Tone::Warn },
                        ),
                        // "which pod is actually serving this, and where" is the
                        // question this table answers, so both open (B41).
                        Cell::link(
                            target.clone(),
                            Tone::Secondary,
                            Some(NavTarget::namespaced("pods", namespace, target.clone())),
                        ),
                        Cell::link(
                            node.clone(),
                            Tone::Secondary,
                            Some(NavTarget::cluster("nodes", node.clone())),
                        ),
                    ]);
                }
            }
        }
    }
    props.push_table(
        "Endpoints",
        Some("no endpoints — nothing is backing this service"),
        &["ADDRESS", "READY", "POD", "NODE"],
        ep_rows,
    );

    meta_sections(&mut props, &svc);
    Ok(props)
}

// ---------------------------------------------------------------------------
// StatefulSets (B18)
// ---------------------------------------------------------------------------

async fn gather_statefulset(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
    let sts = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = sts.spec.clone().unwrap_or_default();
    let status = sts.status.clone().unwrap_or_default();
    let mut props = Properties::default();

    // The governing headless Service is what gives the pods stable DNS.
    // `serviceName` is a required field but *not* a guarantee the Service exists
    // — Argo's application-controller names one that was never created — so
    // verify before linking, the same rule the volume sources follow. A missing
    // one is worth flagging rather than quietly linking nowhere: without it the
    // pods' DNS names don't resolve.
    let svc_name = spec.service_name.clone();
    let svc_exists = !svc_name.is_empty()
        && Api::<Service>::namespaced(client.clone(), namespace)
            .get_metadata(&svc_name)
            .await
            .is_ok();
    let service_field = match (svc_name.is_empty(), svc_exists) {
        (true, _) => field("service name", DASH),
        (false, true) => nav_field(
            "service name",
            svc_name.clone(),
            Some(NavTarget::namespaced("services", namespace, svc_name.clone())),
        ),
        (false, false) => {
            field_toned("service name", format!("{svc_name} (not found)"), Tone::Warn)
        }
    };

    let desired = spec.replicas.unwrap_or(1);
    let ready = status.ready_replicas.unwrap_or(0);

    props.fields(
        "Overview",
        vec![
            field_toned("replicas", format!("{ready}/{desired} ready"), ready_tone(ready, desired)),
            field("current", status.current_replicas.unwrap_or(0).to_string()),
            field("updated", status.updated_replicas.unwrap_or(0).to_string()),
            service_field,
            field(
                "update strategy",
                spec.update_strategy
                    .as_ref()
                    .and_then(|u| u.type_.clone())
                    .unwrap_or_else(|| DASH.into()),
            ),
            field("pod management", or_dash(spec.pod_management_policy.clone())),
            field("selector", selector_text(spec.selector.match_labels.as_ref())),
            field("current revision", or_dash(status.current_revision.clone())),
        ],
    );

    // ---- volume claim templates ----
    let templates = spec.volume_claim_templates.clone().unwrap_or_default();
    props.push_table(
        "Volume claim templates",
        None,
        &["NAME", "CLASS", "ACCESS", "REQUEST"],
        templates
            .iter()
            .map(|t| {
                let ts = t.spec.clone().unwrap_or_default();
                let class = or_dash(ts.storage_class_name.clone());
                vec![
                    // The template itself isn't an object you can open — only the
                    // class it provisions from is.
                    name_cell(t.metadata.name.clone().unwrap_or_default()),
                    Cell::link(
                        class.clone(),
                        Tone::Secondary,
                        Some(NavTarget::cluster("storageclasses", class)),
                    ),
                    c(ts
                        .access_modes
                        .as_ref()
                        .map(|a| a.join(", "))
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| DASH.into())),
                    c(qty(ts
                        .resources
                        .as_ref()
                        .and_then(|r| r.requests.as_ref())
                        .and_then(|r| r.get("storage")))),
                ]
            })
            .collect(),
    );

    // ---- the PVCs those templates actually produced ----
    // StatefulSet PVCs are named "<template>-<statefulset>-<ordinal>" by the
    // controller; that convention is the only link back (they carry no owner ref
    // to the StatefulSet).
    if !templates.is_empty() {
        let prefixes: Vec<String> = templates
            .iter()
            .filter_map(|t| t.metadata.name.clone())
            .map(|n| format!("{n}-{name}-"))
            .collect();
        let pvc_rows = match Api::<PersistentVolumeClaim>::namespaced(client, namespace)
            .list(&ListParams::default())
            .await
        {
            Ok(list) => {
                let mut claims: Vec<PersistentVolumeClaim> = list
                    .items
                    .into_iter()
                    .filter(|p| {
                        let n = p.name_any();
                        prefixes.iter().any(|pre| n.starts_with(pre.as_str()))
                    })
                    .collect();
                claims.sort_by_key(|a| a.name_any());
                claims
                    .iter()
                    .map(|p| {
                        let ps = p.spec.clone().unwrap_or_default();
                        let pst = p.status.clone().unwrap_or_default();
                        let phase = or_dash(pst.phase.clone());
                        let class = or_dash(ps.storage_class_name.clone());
                        let volume = or_dash(ps.volume_name.clone());
                        vec![
                            // A StatefulSet's storage is the one panel where every
                            // reference used to dead-end (B41).
                            Cell::link(
                                p.name_any(),
                                Tone::Primary,
                                Some(NavTarget::namespaced(
                                    "persistentvolumeclaims",
                                    namespace,
                                    p.name_any(),
                                )),
                            ),
                            Cell::new(
                                phase.clone(),
                                if phase == "Bound" { Tone::Good } else { Tone::Warn },
                            ),
                            c(qty(pst.capacity.as_ref().and_then(|cap| cap.get("storage")))),
                            Cell::link(
                                class.clone(),
                                Tone::Secondary,
                                Some(NavTarget::cluster("storageclasses", class)),
                            ),
                            Cell::link(
                                volume.clone(),
                                Tone::Secondary,
                                Some(NavTarget::cluster("persistentvolumes", volume)),
                            ),
                            Cell::age(p.creation_timestamp().map(|t| t.0.to_rfc3339())),
                        ]
                    })
                    .collect()
            }
            Err(_) => Vec::new(),
        };
        props.push_table(
            "Persistent volume claims",
            Some("no claims yet"),
            &["NAME", "PHASE", "CAPACITY", "CLASS", "PV", "AGE"],
            pvc_rows,
        );
    }

    conditions_section(
        &mut props,
        status
            .conditions
            .unwrap_or_default()
            .into_iter()
            .map(|cd| Condition {
                type_: cd.type_,
                status: cd.status,
                reason: or_dash(cd.reason),
                message: or_dash(cd.message),
                since: cd.last_transition_time.map(|t| t.0.to_rfc3339()),
            })
            .collect(),
    );

    meta_sections(&mut props, &sts);
    Ok(props)
}

// ---------------------------------------------------------------------------
// Storage kinds + ReplicaSets (B46)
// ---------------------------------------------------------------------------

/// Events for an object as a properties table's rows: TYPE, REASON, COUNT,
/// MESSAGE, AGE — newest first, the same field-select the events tab uses.
async fn object_events(client: &Client, namespace: &str, name: &str) -> Vec<Vec<Cell>> {
    let api: Api<Event> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default()
        .fields(&format!("involvedObject.name={name},involvedObject.namespace={namespace}"));
    let mut list = match api.list(&lp).await {
        Ok(l) => l.items,
        Err(_) => return Vec::new(), // RBAC/transient: an empty events section
    };
    list.sort_by_key(|e| std::cmp::Reverse(event_last_seen(e)));
    list.into_iter()
        .map(|e| {
            let warn = e.type_.as_deref() == Some("Warning");
            vec![
                Cell::new(e.type_.clone().unwrap_or_else(|| "Normal".into()), if warn { Tone::Bad } else { Tone::Good }),
                Cell::new(e.reason.clone().unwrap_or_default(), Tone::Primary),
                Cell::new(format!("×{}", e.count.unwrap_or(1)), Tone::Secondary),
                Cell::new(e.message.clone().unwrap_or_default(), Tone::Secondary),
                Cell::age(Some(event_last_seen(&e).to_rfc3339())),
            ]
        })
        .collect()
}

/// Best "last seen" time for an event: lastTimestamp, else eventTime, else creation.
fn event_last_seen(e: &Event) -> chrono::DateTime<chrono::Utc> {
    if let Some(t) = &e.last_timestamp {
        return t.0;
    }
    if let Some(t) = &e.event_time {
        return t.0;
    }
    e.creation_timestamp().map(|t| t.0).unwrap_or_else(chrono::Utc::now)
}

/// Tone for a claim/volume phase, matching the tables' storageTone.
fn phase_tone(phase: &str) -> Tone {
    match phase {
        "Bound" => Tone::Good,
        "Available" => Tone::Secondary,
        "Lost" | "Failed" => Tone::Bad,
        _ => Tone::Warn, // Pending / Released
    }
}

/// Properties for a PersistentVolumeClaim (B46): its state, volume and class as
/// links, the pods that mount it (the reverse of a pod's Storage section), and
/// its events.
async fn gather_pvc(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
    let pvc = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = pvc.spec.clone().unwrap_or_default();
    let status = pvc.status.clone().unwrap_or_default();
    let mut props = Properties::default();

    props.fields(
        "Overview",
        vec![
            field_toned("status", or_dash(status.phase.clone()), phase_tone(status.phase.as_deref().unwrap_or(""))),
            field(
                "capacity",
                status
                    .capacity
                    .as_ref()
                    .and_then(|c| c.get("storage"))
                    .map(|q| q.0.clone())
                    .unwrap_or_else(|| DASH.into()),
            ),
            field("access modes", spec.access_modes.map(|a| a.join(", ")).unwrap_or_else(|| DASH.into())),
            nav_field(
                "storage class",
                or_dash(spec.storage_class_name.clone()),
                spec.storage_class_name
                    .clone()
                    .filter(|s| !s.is_empty())
                    .map(|s| NavTarget::cluster("storageclasses", s)),
            ),
            nav_field(
                "volume",
                or_dash(spec.volume_name.clone()),
                spec.volume_name
                    .clone()
                    .filter(|v| !v.is_empty())
                    .map(|v| NavTarget::cluster("persistentvolumes", v)),
            ),
        ],
    );

    // Who mounts this claim — the reverse of a pod's Storage section.
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod_list = pods.list(&ListParams::default()).await.map(|l| l.items).unwrap_or_default();
    let mut rows = Vec::new();
    for p in &pod_list {
        let Some(pspec) = p.spec.clone() else { continue };
        let pname = p.metadata.name.clone().unwrap_or_default();
        let Some(vol) = pspec
            .volumes
            .iter()
            .flatten()
            .find(|v| v.persistent_volume_claim.as_ref().map(|c| c.claim_name.as_str()) == Some(name))
        else {
            continue;
        };
        for ct in &pspec.containers {
            for m in ct.volume_mounts.iter().flatten() {
                if m.name == vol.name {
                    rows.push(vec![
                        Cell::link(
                            pname.clone(),
                            Tone::Primary,
                            Some(NavTarget::namespaced("pods", namespace, pname.clone())),
                        ),
                        c(ct.name.clone()),
                        c(m.mount_path.clone()),
                    ]);
                }
            }
        }
    }
    props.push_table(
        "Mounted by",
        Some("no pods mount this claim"),
        &["POD", "CONTAINER", "MOUNT PATH"],
        rows,
    );

    props.push_table(
        "Events",
        Some("no events"),
        &["TYPE", "REASON", "COUNT", "MESSAGE", "AGE"],
        object_events(&client, namespace, name).await,
    );

    meta_sections(&mut props, &pvc);
    Ok(props)
}

/// Properties for a PersistentVolume (B46): its reclaim state, and the claim it
/// is bound to as a link. PVs are cluster-scoped, so `namespace` is only used to
/// resolve the claim's own namespace.
async fn gather_pv(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<PersistentVolume> = Api::all(client.clone());
    let pv = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = pv.spec.clone().unwrap_or_default();
    let status = pv.status.clone().unwrap_or_default();
    let mut props = Properties::default();

    let claim_text = spec
        .claim_ref
        .as_ref()
        .map(|c| format!("{}/{}", c.namespace.clone().unwrap_or_default(), c.name.clone().unwrap_or_default()))
        .unwrap_or_else(|| DASH.into());
    props.fields(
        "Overview",
        vec![
            field_toned("status", or_dash(status.phase.clone()), phase_tone(status.phase.as_deref().unwrap_or(""))),
            field(
                "capacity",
                spec.capacity
                    .as_ref()
                    .and_then(|c| c.get("storage"))
                    .map(|q| q.0.clone())
                    .unwrap_or_else(|| DASH.into()),
            ),
            field("access modes", spec.access_modes.map(|a| a.join(", ")).unwrap_or_else(|| DASH.into())),
            field("reclaim policy", or_dash(spec.persistent_volume_reclaim_policy.clone())),
            nav_field(
                "storage class",
                or_dash(spec.storage_class_name.clone()),
                spec.storage_class_name
                    .clone()
                    .filter(|s| !s.is_empty())
                    .map(|s| NavTarget::cluster("storageclasses", s)),
            ),
            nav_field(
                "claim",
                claim_text,
                spec.claim_ref.clone().map(|c| {
                    NavTarget::namespaced(
                        "persistentvolumeclaims",
                        c.namespace.unwrap_or_else(|| namespace.to_string()),
                        c.name.unwrap_or_default(),
                    )
                }),
            ),
        ],
    );

    meta_sections(&mut props, &pv);
    Ok(props)
}

/// Properties for a ReplicaSet (B46): the revision generation's state, its
/// owning Deployment, and the pods it owns.
async fn gather_replicaset(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
    let rs = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = rs.spec.clone().unwrap_or_default();
    let status = rs.status.clone().unwrap_or_default();
    let desired = spec.replicas.unwrap_or(0);
    let ready = status.ready_replicas.unwrap_or(0);
    let mut props = Properties::default();

    // The controller owner reference — a Deployment when this generation is
    // managed by one (the usual case), any listed kind otherwise.
    let (owner_text, owner_nav) = match rs
        .metadata
        .owner_references
        .as_ref()
        .and_then(|r| r.iter().find(|o| o.controller == Some(true)))
    {
        Some(owner) => (
            format!("{}/{}", owner.kind, owner.name),
            builtin_nav_id(&owner.kind)
                .map(|nav| NavTarget::namespaced(nav, namespace, owner.name.clone())),
        ),
        None => (DASH.into(), None),
    };

    props.fields(
        "Overview",
        vec![
            field_toned("ready", format!("{ready}/{desired}"), ready_tone(ready, desired)),
            field("desired", desired.to_string()),
            field("current", status.replicas.to_string()),
            nav_field("owner", owner_text, owner_nav),
        ],
    );

    // The pods this ReplicaSet owns, by owner uid (name reuse is real).
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod_list = pods.list(&ListParams::default()).await.map(|l| l.items).unwrap_or_default();
    let rows: Vec<Vec<Cell>> = pod_list
        .iter()
        .filter(|p| {
            p.metadata
                .owner_references
                .iter()
                .flatten()
                .any(|o| Some(&o.uid) == rs.metadata.uid.as_ref())
        })
        .map(|p| {
            let pname = p.metadata.name.clone().unwrap_or_default();
            let phase = p
                .status
                .as_ref()
                .and_then(|s| s.phase.clone())
                .unwrap_or_else(|| "Unknown".into());
            let tone = match phase.as_str() {
                "Running" => Tone::Good,
                "Pending" | "ContainerCreating" => Tone::Warn,
                _ => Tone::Secondary,
            };
            vec![
                Cell::link(pname.clone(), Tone::Primary, Some(NavTarget::namespaced("pods", namespace, pname))),
                Cell::new(phase, tone),
            ]
        })
        .collect();
    props.push_table("Pods", Some("no pods owned"), &["POD", "STATUS"], rows);

    meta_sections(&mut props, &rs);
    Ok(props)
}

// ---------------------------------------------------------------------------
// RBAC (B49)
// ---------------------------------------------------------------------------

/// Does a binding's subjects include the named ServiceAccount? A subject's
/// namespace must match the SA's — for a namespaced binding that's its own
/// namespace; for a cluster binding the subject names the SA's namespace.
fn subjects_sa(subjects: Option<&Vec<Subject>>, namespace: &str, name: &str) -> bool {
    subjects
        .map(|s| {
            s.iter().any(|sub| {
                sub.kind == "ServiceAccount"
                    && sub.name == name
                    && sub.namespace.as_deref() == Some(namespace)
            })
        })
        .unwrap_or(false)
}

/// A cell for a binding's role reference, linking to the referenced
/// Role/ClusterRole. `binding_ns` is the binding's own namespace — a namespaced
/// Role lives there; a ClusterRole is cluster-wide.
fn role_link_cell(kind: &str, name: &str, binding_ns: &str) -> Cell {
    match kind {
        "Role" => Cell::link(
            name.to_string(),
            Tone::Secondary,
            Some(NavTarget::namespaced("roles", binding_ns, name)),
        ),
        "ClusterRole" => Cell::link(name.to_string(), Tone::Secondary, Some(NavTarget::cluster("clusterroles", name))),
        _ => Cell::new(format!("{kind}/{name}"), Tone::Secondary),
    }
}

/// Comma-joined values ("get,list,watch"), or "—" when absent.
fn join_csv(items: &Option<Vec<String>>) -> String {
    match items {
        Some(list) if !list.is_empty() => list.join(","),
        _ => DASH.into(),
    }
}

/// Properties for a ServiceAccount (B49): an Overview, then the resolved RBAC
/// chain — the bindings that name it (each linking to its role) and those
/// roles' rules as a compact verb×resource table.
async fn gather_serviceaccount(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
    let sa = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let mut props = Properties::default();

    props.fields(
        "Overview",
        vec![
            field("secrets", sa.secrets.as_ref().map(|s| s.len().to_string()).unwrap_or_else(|| "0".into())),
            field("image pull secrets", sa.image_pull_secrets.as_ref().map(|s| s.len().to_string()).unwrap_or_else(|| "0".into())),
            field(
                "automount token",
                if sa.automount_service_account_token.unwrap_or(false) { "yes" } else { "no" },
            ),
        ],
    );

    // ---- bindings naming this SA: namespaced RoleBindings, then cluster ones ----
    // (binding name, binding kind, role kind, role name)
    let mut bindings: Vec<(String, &'static str, String, String)> = Vec::new();
    let rb_api: Api<RoleBinding> = Api::namespaced(client.clone(), namespace);
    if let Ok(list) = rb_api.list(&ListParams::default()).await {
        for b in list.items {
            if subjects_sa(b.subjects.as_ref(), namespace, name) {
                bindings.push((b.name_any(), "RoleBinding", b.role_ref.kind.clone(), b.role_ref.name.clone()));
            }
        }
    }
    let crb_api: Api<ClusterRoleBinding> = Api::all(client.clone());
    if let Ok(list) = crb_api.list(&ListParams::default()).await {
        for b in list.items {
            if subjects_sa(b.subjects.as_ref(), namespace, name) {
                bindings.push((b.name_any(), "ClusterRoleBinding", b.role_ref.kind.clone(), b.role_ref.name.clone()));
            }
        }
    }

    let binding_rows: Vec<Vec<Cell>> = bindings
        .iter()
        .map(|(bname, bkind, rkind, rname)| {
            let bnav = if *bkind == "RoleBinding" {
                NavTarget::namespaced("rolebindings", namespace, bname)
            } else {
                NavTarget::cluster("clusterrolebindings", bname)
            };
            vec![
                Cell::link(bname.clone(), Tone::Primary, Some(bnav)),
                c(bkind.to_string()),
                role_link_cell(rkind, rname, namespace),
            ]
        })
        .collect();
    props.push_table(
        "Role bindings",
        Some("no bindings grant this account"),
        &["BINDING", "TYPE", "ROLE"],
        binding_rows,
    );

    // ---- the referenced roles' rules, one row per rule ----
    let role_api: Api<Role> = Api::namespaced(client.clone(), namespace);
    let cluster_role_api: Api<ClusterRole> = Api::all(client);
    let mut rule_rows: Vec<Vec<Cell>> = Vec::new();
    for (_, _, rkind, rname) in &bindings {
        let rules: Vec<PolicyRule> = match rkind.as_str() {
            "Role" => role_api.get_opt(rname).await.ok().flatten().and_then(|r| r.rules).unwrap_or_default(),
            _ => cluster_role_api.get_opt(rname).await.ok().flatten().and_then(|r| r.rules).unwrap_or_default(),
        };
        for rule in rules {
            // A rule grants verbs over resources (or non-resource URLs).
            let resources = rule
                .resources
                .filter(|r| !r.is_empty())
                .or(rule.non_resource_urls)
                .unwrap_or_default();
            rule_rows.push(vec![
                name_cell(rname.clone()),
                c(join_csv(&Some(rule.verbs))),
                c(if resources.is_empty() { DASH.into() } else { resources.join(",") }),
                c(join_csv(&rule.api_groups)),
            ]);
        }
    }
    props.push_table(
        "Rules",
        Some("no rules (the roles are empty or unreadable)"),
        &["ROLE", "VERB", "RESOURCES", "API GROUPS"],
        rule_rows,
    );

    meta_sections(&mut props, &sa);
    Ok(props)
}

/// Properties for a RoleBinding (B49): the role it grants, and its subjects —
/// ServiceAccount subjects existence-checked (an absent SA renders "not found").
async fn gather_rolebinding(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<RoleBinding> = Api::namespaced(client.clone(), namespace);
    let b = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let mut props = Properties::default();

    props.fields(
        "Overview",
        vec![
            nav_field("role", format!("{}/{}", b.role_ref.kind, b.role_ref.name), role_nav_of(&b.role_ref, namespace)),
            field("subjects", b.subjects.as_ref().map(|s| s.len().to_string()).unwrap_or_else(|| "0".into())),
        ],
    );

    let sa_api: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
    let mut rows = Vec::new();
    for sub in b.subjects.as_ref().into_iter().flatten() {
        // ServiceAccount subjects existence-check via ref_cell; a deleted SA
        // that the binding still names is exactly the "not found" case.
        let cell = if sub.kind == "ServiceAccount" {
            let exists = sa_api.get_metadata(&sub.name).await.is_ok();
            ref_cell(&sub.name, exists, NavTarget::namespaced("serviceaccounts", namespace, sub.name.clone()))
        } else {
            c(format!("{}/{}", sub.kind, sub.name))
        };
        rows.push(vec![c(sub.kind.clone()), cell, c(or_dash(sub.namespace.clone()))]);
    }
    props.push_table("Subjects", Some("no subjects"), &["KIND", "NAME", "NAMESPACE"], rows);

    meta_sections(&mut props, &b);
    Ok(props)
}

/// Properties for a ClusterRoleBinding (B49), like a RoleBinding but cluster
/// scoped — each subject's SA is checked in its own namespace.
async fn gather_clusterrolebinding(client: Client, name: &str) -> AppResult<Properties> {
    let api: Api<ClusterRoleBinding> = Api::all(client.clone());
    let b = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let mut props = Properties::default();

    props.fields(
        "Overview",
        vec![
            nav_field("role", format!("{}/{}", b.role_ref.kind, b.role_ref.name), role_nav_of(&b.role_ref, "")),
            field("subjects", b.subjects.as_ref().map(|s| s.len().to_string()).unwrap_or_else(|| "0".into())),
        ],
    );

    let mut rows = Vec::new();
    for sub in b.subjects.as_ref().into_iter().flatten() {
        let cell = if sub.kind == "ServiceAccount" {
            let sub_ns = sub.namespace.clone().unwrap_or_default();
            let exists = Api::<ServiceAccount>::namespaced(client.clone(), &sub_ns)
                .get_metadata(&sub.name)
                .await
                .is_ok();
            ref_cell(&sub.name, exists, NavTarget::namespaced("serviceaccounts", &sub_ns, sub.name.clone()))
        } else {
            c(format!("{}/{}", sub.kind, sub.name))
        };
        rows.push(vec![c(sub.kind.clone()), cell, c(or_dash(sub.namespace.clone()))]);
    }
    props.push_table("Subjects", Some("no subjects"), &["KIND", "NAME", "NAMESPACE"], rows);

    meta_sections(&mut props, &b);
    Ok(props)
}

/// The nav target for a role reference, or None for an unknown kind.
fn role_nav_of(r: &k8s_openapi::api::rbac::v1::RoleRef, binding_ns: &str) -> Option<NavTarget> {
    match r.kind.as_str() {
        "Role" => Some(NavTarget::namespaced("roles", binding_ns, r.name.clone())),
        "ClusterRole" => Some(NavTarget::cluster("clusterroles", r.name.clone())),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Secrets (B37)
// ---------------------------------------------------------------------------

/// Properties for a Secret: an Overview plus a Data table of *keys* (B37).
///
/// Values never render — the YAML tab redacts them and this panel lists only the
/// keys. Each key's value is reachable only through the clipboard command, which
/// decodes and writes in Rust so the plaintext never enters the webview.
async fn gather_secret(client: Client, namespace: &str, name: &str) -> AppResult<Properties> {
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let secret = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let data = secret.data.clone().unwrap_or_default();
    let string_data = secret.string_data.clone().unwrap_or_default();
    let mut props = Properties::default();

    props.fields(
        "Overview",
        vec![
            field("type", or_dash(secret.type_.clone())),
            field("keys", (data.len() + string_data.len()).to_string()),
            field("immutable", if secret.immutable.unwrap_or(false) { "yes" } else { "no" }),
        ],
    );

    // Keys with their source; values stay on the backend.
    let mut keys: Vec<(String, &'static str)> = Vec::new();
    for k in data.keys() {
        keys.push((k.clone(), "data (base64)"));
    }
    for k in string_data.keys() {
        keys.push((k.clone(), "stringData"));
    }
    keys.sort();
    let rows: Vec<Vec<Cell>> = keys
        .iter()
        .map(|(k, src)| vec![name_cell(k.clone()), c(src.to_string())])
        .collect();
    props.push_table("Data", Some("no data"), &["KEY", "SOURCE"], rows);

    // For a TLS secret, the *public* certificate's metadata is shown — expiry is
    // the thing that takes sites down, and the private key is never touched (B48).
    if secret.type_.as_deref() == Some("kubernetes.io/tls") {
        if let Some(cert) = data.get("tls.crt").and_then(|bs| tls::parse_crt(&bs.0)) {
            let not_after_tone = cert_tone(&cert.not_after, chrono::Utc::now());
            let mut expires = Cell::age(Some(cert.not_after.clone()).filter(|s| !s.is_empty()));
            expires.tone = not_after_tone;
            props.fields(
                "Certificate",
                vec![
                    field("subject", cert.subject),
                    field("SANs", cert.san),
                    field("issuer", cert.issuer),
                    Field {
                        label: "valid from".into(),
                        value: Cell::age(Some(cert.not_before).filter(|s| !s.is_empty())),
                        nav: None,
                    },
                    Field { label: "expires".into(), value: expires, nav: None },
                ],
            );
        }
    }

    meta_sections(&mut props, &secret);
    Ok(props)
}

/// The tone for a certificate's notAfter: expired is red, under 30 days amber —
/// the two cases worth seeing from the routing side (B48).
fn cert_tone(not_after: &str, now: chrono::DateTime<chrono::Utc>) -> Tone {
    let Ok(end) = chrono::DateTime::parse_from_rfc3339(not_after)
        .map(|d| d.with_timezone(&chrono::Utc))
    else {
        return Tone::Secondary;
    };
    if end < now {
        Tone::Bad
    } else if end - now < chrono::Duration::days(30) {
        Tone::Warn
    } else {
        Tone::Secondary
    }
}

/// The notAfter tone of a Secret's certificate, when it's a TLS secret whose
/// public cert parses — None otherwise, so a non-TLS secret keeps its normal
/// link tone (B48).
async fn secret_cert_tone(api: &Api<Secret>, name: &str) -> Option<Tone> {
    let secret = api.get(name).await.ok()?;
    if secret.type_.as_deref() != Some("kubernetes.io/tls") {
        return None;
    }
    let bs = secret.data?.get("tls.crt")?.clone();
    let cert = tls::parse_crt(&bs.0)?;
    Some(cert_tone(&cert.not_after, chrono::Utc::now()))
}

// ---------------------------------------------------------------------------
// Nodes (B18)
// ---------------------------------------------------------------------------

async fn gather_node(client: Client, name: &str) -> AppResult<Properties> {
    let api: Api<Node> = Api::all(client);
    let node = api.get(name).await.map_err(|e| AppError::Kube(e.to_string()))?;
    let spec = node.spec.clone().unwrap_or_default();
    let status = node.status.clone().unwrap_or_default();
    let info = status.node_info.clone();
    let mut props = Properties::default();

    let unschedulable = spec.unschedulable.unwrap_or(false);
    props.fields(
        "Overview",
        vec![
            field_toned(
                "schedulable",
                if unschedulable { "no (cordoned)" } else { "yes" },
                if unschedulable { Tone::Warn } else { Tone::Good },
            ),
            field("kubelet", info.as_ref().map(|i| i.kubelet_version.clone()).unwrap_or_else(|| DASH.into())),
            field("runtime", info.as_ref().map(|i| i.container_runtime_version.clone()).unwrap_or_else(|| DASH.into())),
            field("OS image", info.as_ref().map(|i| i.os_image.clone()).unwrap_or_else(|| DASH.into())),
            field("kernel", info.as_ref().map(|i| i.kernel_version.clone()).unwrap_or_else(|| DASH.into())),
            field("architecture", info.as_ref().map(|i| i.architecture.clone()).unwrap_or_else(|| DASH.into())),
            field("pod CIDR", or_dash(spec.pod_cidr.clone())),
            field("provider", or_dash(spec.provider_id.clone())),
        ],
    );

    // ---- capacity vs allocatable ----
    // Allocatable is capacity minus what the kubelet reserves for the system, so
    // it — not capacity — is what pods can actually request.
    let capacity = status.capacity.clone().unwrap_or_default();
    let allocatable = status.allocatable.clone().unwrap_or_default();
    // Union of both maps: extended resources (GPUs) may appear in only one.
    let mut resource_names: Vec<&String> = capacity.keys().chain(allocatable.keys()).collect();
    resource_names.sort();
    resource_names.dedup();
    props.push_table(
        "Capacity",
        Some("not reported"),
        &["RESOURCE", "CAPACITY", "ALLOCATABLE"],
        resource_names
            .iter()
            .map(|r| {
                vec![
                    name_cell((*r).clone()),
                    c(qty(capacity.get(*r))),
                    c(qty(allocatable.get(*r))),
                ]
            })
            .collect(),
    );

    conditions_section(
        &mut props,
        status
            .conditions
            .unwrap_or_default()
            .into_iter()
            .map(|cd| Condition {
                type_: cd.type_,
                status: cd.status,
                reason: or_dash(cd.reason),
                message: or_dash(cd.message),
                since: cd.last_transition_time.map(|t| t.0.to_rfc3339()),
            })
            .collect(),
    );

    // ---- taints ----
    props.push_table(
        "Taints",
        Some("no taints"),
        &["KEY", "VALUE", "EFFECT"],
        spec.taints
            .iter()
            .flatten()
            .map(|t| {
                vec![
                    name_cell(t.key.clone()),
                    c(or_dash(t.value.clone())),
                    // NoSchedule/NoExecute actively keep pods off; worth the amber.
                    Cell::new(t.effect.clone(), Tone::Warn),
                ]
            })
            .collect(),
    );

    // ---- addresses ----
    props.push_table(
        "Addresses",
        Some("no addresses"),
        &["TYPE", "ADDRESS"],
        status
            .addresses
            .iter()
            .flatten()
            .map(|a| vec![name_cell(a.type_.clone()), c(a.address.clone())])
            .collect(),
    );

    meta_sections(&mut props, &node);
    Ok(props)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Ready/Available read green when True; the same status on a pressure
    /// condition reads red, because those inverted types mean the opposite.
    #[test]
    fn condition_polarity_is_per_type() {
        assert_eq!(condition_tone("Ready", "True"), Tone::Good);
        assert_eq!(condition_tone("Ready", "False"), Tone::Bad);
        assert_eq!(condition_tone("Available", "True"), Tone::Good);
        // A node under memory pressure is unhealthy, not healthy.
        assert_eq!(condition_tone("MemoryPressure", "True"), Tone::Bad);
        assert_eq!(condition_tone("MemoryPressure", "False"), Tone::Good);
        assert_eq!(condition_tone("DiskPressure", "True"), Tone::Bad);
        assert_eq!(condition_tone("ReplicaFailure", "True"), Tone::Bad);
    }

    /// An unreported condition ("Unknown") is a warning either way.
    #[test]
    fn unknown_condition_is_a_warning() {
        assert_eq!(condition_tone("Ready", "Unknown"), Tone::Warn);
        assert_eq!(condition_tone("MemoryPressure", "Unknown"), Tone::Warn);
    }

    /// Helm history (B35): revisions decoded in any order render newest-first,
    /// the current revision's status leads the Overview, superseded rows read
    /// muted and the current deployed row reads ok, and values are redacted.
    #[test]
    fn helm_history_orders_and_tones() {
        let rel = |revision: i64, status: &str| helm::Release {
            name: "redis".into(),
            namespace: "prod".into(),
            chart: "redis-1.2.3".into(),
            app_version: "7.2".into(),
            revision,
            status: status.into(),
            updated: format!("2026-06-0{revision}T00:00:00Z"),
            first_deployed: "2026-06-01T00:00:00Z".into(),
            description: "Upgrade complete".into(),
            config: serde_json::json!({ "auth": { "password": "hunter2" }, "replicas": 3 }),
            manifest: String::new(),
        };
        // Deliberately unsorted input: v1, v3, v2.
        let props = build_helm_properties(vec![
            rel(1, "superseded"),
            rel(3, "deployed"),
            rel(2, "superseded"),
        ]);

        // Overview leads with the current (highest) revision.
        let overview = match &props.sections[0].body {
            Body::Fields { fields } => fields,
            _ => panic!("first section is the Overview grid"),
        };
        let status = overview.iter().find(|f| f.label == "status").unwrap();
        assert_eq!(status.value.text, "deployed");
        assert_eq!(status.value.tone, Tone::Good, "current deployed reads ok");
        let revision = overview.iter().find(|f| f.label == "revision").unwrap();
        assert_eq!(revision.value.text, "3");

        // History is newest-first, with the right per-row toning.
        let history = props.sections.iter().find(|s| s.title == "History").unwrap();
        let rows = match &history.body {
            Body::Table { rows, .. } => rows,
            _ => panic!("History is a table"),
        };
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0][0].text, "3");
        assert_eq!(rows[0][1].tone, Tone::Good, "current revision ok");
        assert_eq!(rows[1][0].text, "2");
        assert_eq!(rows[1][1].tone, Tone::Muted, "superseded reads muted");
        assert_eq!(rows[2][0].text, "1");

        // Values are redacted, and the password never reaches the cells.
        let values = props.sections.iter().find(|s| s.title == "Values").unwrap();
        let vrows = match &values.body {
            Body::Table { rows, .. } => rows,
            _ => panic!("Values is a table"),
        };
        let dumped = format!("{vrows:?}");
        assert!(!dumped.contains("hunter2"), "the password must never reach the payload");
        assert!(vrows.iter().any(|r| r[0].text == "auth.password" && r[1].text == "<redacted>"));
        assert!(vrows.iter().any(|r| r[0].text == "replicas" && r[1].text == "3"));
    }

    /// A release's rendered manifest yields its installed objects' kind/name
    /// pairs — including a CRD kind we don't model — and a broken doc is skipped.
    #[test]
    fn manifest_objects_parses_kind_and_name() {
        let manifest = "\
apiVersion: v1
kind: Service
metadata:
  name: traefik
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: traefik
---
not a yaml document
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: gw
";
        assert_eq!(
            manifest_objects(manifest),
            vec![
                ("Service".to_string(), "traefik".to_string()),
                ("Deployment".to_string(), "traefik".to_string()),
                ("Gateway".to_string(), "gw".to_string()),
            ]
        );
    }

    /// The release's Objects table links every kind we list; a CRD kind we don't
    /// model renders as plain text rather than a dead link.
    #[test]
    fn helm_objects_table_links_listed_kinds() {
        let rel = helm::Release {
            name: "traefik".into(),
            namespace: "kube-system".into(),
            chart: "traefik-1.0.0".into(),
            app_version: "v1".into(),
            revision: 1,
            status: "deployed".into(),
            updated: "2026-06-01T00:00:00Z".into(),
            first_deployed: "2026-06-01T00:00:00Z".into(),
            description: "Install complete".into(),
            config: serde_json::json!({}),
            manifest: "\
kind: Service
metadata:
  name: traefik
---
kind: Gateway
metadata:
  name: gw
"
            .into(),
        };
        let props = build_helm_properties(vec![rel]);
        let objects = props.sections.iter().find(|s| s.title == "Objects").unwrap();
        let rows = match &objects.body {
            Body::Table { rows, .. } => rows,
            _ => panic!("Objects is a table"),
        };
        assert_eq!(rows.len(), 2);
        // Service → services nav; Gateway (a CRD we don't list) stays plain.
        assert_eq!(rows[0][1].nav.as_ref().map(|t| t.kind.as_str()), Some("services"));
        assert_eq!(rows[0][1].nav.as_ref().and_then(|t| t.namespace.as_deref()), Some("kube-system"));
        assert!(rows[1][1].nav.is_none());
    }

    /// An Ingress backend port is a number *or* a name; freya's only Ingress uses
    /// a name, so a number-only reading would silently show nothing.
    #[test]
    fn backend_port_takes_a_number_or_a_name() {
        let port = |v: serde_json::Value| -> k8s_openapi::api::networking::v1::ServiceBackendPort {
            serde_json::from_value(v).unwrap()
        };
        assert_eq!(backend_port(Some(&port(serde_json::json!({ "number": 8080 })))), "8080");
        assert_eq!(backend_port(Some(&port(serde_json::json!({ "name": "http" })))), "http");
        // A number wins when both are somehow set, matching the API's precedence.
        assert_eq!(backend_port(Some(&port(serde_json::json!({ "number": 80, "name": "http" })))), "80");
        assert_eq!(backend_port(None), "—");
    }

    /// A reference that resolves becomes a link; one that doesn't says so rather
    /// than linking to a 404 (B42) — the rule the whole audit kept re-learning.
    #[test]
    fn ref_cell_links_only_what_exists() {
        let target = || NavTarget::namespaced("services", "prod", "api");

        let present = ref_cell("api", true, target());
        assert_eq!(present.text, "api");
        assert!(present.nav.is_some());
        assert_eq!(present.tone, Tone::Secondary);

        let missing = ref_cell("api", false, target());
        assert_eq!(missing.text, "api (not found)");
        assert!(missing.nav.is_none(), "never link to something that isn't there");
        assert_eq!(missing.tone, Tone::Warn);

        // "nothing referenced" is not the same as "referenced but missing".
        let none = ref_cell(DASH, false, target());
        assert_eq!(none.text, DASH);
        assert!(none.nav.is_none());
        assert_eq!(none.tone, Tone::Secondary);
    }

    /// Owner-kind → nav id: kinds we list resolve; kinds we don't return None so
    /// the reference stays plain text rather than becoming a dead link (B33).
    #[test]
    fn builtin_nav_id_only_maps_listed_kinds() {
        assert_eq!(builtin_nav_id("Deployment"), Some("deployments"));
        assert_eq!(builtin_nav_id("StatefulSet"), Some("statefulsets"));
        assert_eq!(builtin_nav_id("DaemonSet"), Some("daemonsets"));
        assert_eq!(builtin_nav_id("Node"), Some("nodes"));
        // Listed as of B40 — these used to be the canonical dead ends.
        assert_eq!(builtin_nav_id("ReplicaSet"), Some("replicasets"));
        assert_eq!(builtin_nav_id("StorageClass"), Some("storageclasses"));
        assert_eq!(builtin_nav_id("PersistentVolumeClaim"), Some("persistentvolumeclaims"));
        assert_eq!(builtin_nav_id("ServiceAccount"), Some("serviceaccounts"));
        // Still unlisted, so still correctly None.
        assert_eq!(builtin_nav_id("Endpoints"), None);
        assert_eq!(builtin_nav_id("PriorityClass"), None);
        assert_eq!(builtin_nav_id("FooBar"), None);
    }

    /// Inline volume sources resolve to the detail that identifies them: a
    /// ConfigMap links through, while a host path / NFS export / CSI driver is
    /// plain text (they aren't cluster objects to navigate to). Before this, every
    /// non-ConfigMap/Secret volume showed a bare em dash for its source.
    #[test]
    fn volume_source_names_inline_backings() {
        let vol = |body: serde_json::Value| -> k8s_openapi::api::core::v1::Volume {
            serde_json::from_value(body).unwrap()
        };

        let (src, nav) = volume_source(&vol(json!({ "name": "cfg", "configMap": { "name": "app-config" } })), "prod");
        assert_eq!(src, "app-config");
        assert!(nav.is_some(), "a ConfigMap is a listed kind, so it links");

        let (src, nav) = volume_source(&vol(json!({ "name": "data", "hostPath": { "path": "/var/lib/data" } })), "prod");
        assert_eq!(src, "/var/lib/data");
        assert!(nav.is_none(), "a host directory is not a cluster object");

        let (src, _) = volume_source(&vol(json!({ "name": "exports", "nfs": { "server": "nfs01", "path": "/exports/prod" } })), "prod");
        assert_eq!(src, "nfs01:/exports/prod", "shown as mount writes it");

        let (src, _) = volume_source(&vol(json!({ "name": "vault", "csi": { "driver": "secrets-store.csi.k8s.io" } })), "prod");
        assert_eq!(src, "secrets-store.csi.k8s.io");

        // Nothing to name (e.g. an emptyDir) still falls back to the em dash.
        let (src, nav) = volume_source(&vol(json!({ "name": "scratch", "emptyDir": {} })), "prod");
        assert_eq!(src, DASH);
        assert!(nav.is_none());
    }

    /// Replica readiness: all → green, some → amber, none → red.
    #[test]
    fn ready_tone_reflects_shortfall() {
        assert_eq!(ready_tone(3, 3), Tone::Good);
        assert_eq!(ready_tone(1, 3), Tone::Warn);
        assert_eq!(ready_tone(0, 3), Tone::Bad);
        // Scaled to zero deliberately — nothing is wrong.
        assert_eq!(ready_tone(0, 0), Tone::Muted);
    }

    /// Selectors render in the k=v,k2=v2 form kubectl uses.
    #[test]
    fn selector_rendering() {
        let mut m = BTreeMap::new();
        m.insert("app".to_string(), "valkyrie".to_string());
        m.insert("tier".to_string(), "api".to_string());
        assert_eq!(selector_text(Some(&m)), "app=valkyrie,tier=api");
        assert_eq!(selector_text(None), DASH);
        assert_eq!(selector_text(Some(&BTreeMap::new())), DASH);
    }

    /// An empty table with no note is dropped; with a note it's kept.
    #[test]
    fn empty_tables_are_dropped_unless_noted() {
        let mut p = Properties::default();
        p.push_table("Gone", None, &["A"], vec![]);
        assert!(p.sections.is_empty(), "an empty optional section should not render");

        p.push_table("Kept", Some("nothing here"), &["A"], vec![]);
        assert_eq!(p.sections.len(), 1);
        assert_eq!(p.sections[0].title, "Kept");
    }

    /// Empty chip sections never render (a pod with no annotations shows nothing).
    #[test]
    fn empty_chips_are_dropped() {
        let mut p = Properties::default();
        p.chips("Labels", vec![]);
        assert!(p.sections.is_empty());
        p.chips("Labels", vec![KeyValue { key: "a".into(), value: "b".into() }]);
        assert_eq!(p.sections.len(), 1);
    }

    /// An unsupported kind errors rather than returning an empty panel, so a dead
    /// tab can't appear.
    #[tokio::test]
    async fn unknown_kind_is_an_error() {
        // No client call happens for an unknown kind, so a default client is fine.
        let Ok(client) = Client::try_default().await else {
            return; // no kubeconfig in this environment; nothing to assert
        };
        assert!(gather(client, "configmaps", "default", "x").await.is_err());
    }

    // ---- pod references (B46) ----

    /// A pod's pull secrets and env/envFrom sources are collected with their
    /// kind, the object name, the key (for keyed refs) and the using container.
    #[test]
    fn pod_reference_collection() {
        let spec: PodSpec = serde_json::from_value(json!({
            "imagePullSecrets": [{ "name": "registry-pull" }],
            "containers": [
                {
                    "name": "api",
                    "env": [
                        { "name": "LOG_LEVEL", "valueFrom": { "configMapKeyRef": { "name": "app-config", "key": "log-level" } } },
                        { "name": "DB_PASSWORD", "valueFrom": { "secretKeyRef": { "name": "db-creds", "key": "password" } } },
                    ],
                    "envFrom": [
                        { "configMapRef": { "name": "app-config" } },
                        { "secretRef": { "name": "db-creds" } },
                    ],
                },
                { "name": "sidecar" },
            ],
        }))
        .unwrap();

        let refs = collect_pod_refs(&spec);
        assert_eq!(refs.len(), 5);
        assert_eq!(refs[0], ("image pull secret", "registry-pull".into(), "—".into(), "pod".into()));
        assert_eq!(refs[1], ("ConfigMap (env)", "app-config".into(), "log-level".into(), "api".into()));
        assert_eq!(refs[2], ("Secret (env)", "db-creds".into(), "password".into(), "api".into()));
        assert_eq!(refs[3], ("ConfigMap (envFrom)", "app-config".into(), "—".into(), "api".into()));
        assert_eq!(refs[4], ("Secret (envFrom)", "db-creds".into(), "—".into(), "api".into()));
    }

    /// A binding subject matches the SA only on kind, name AND namespace — a
    /// same-named SA in another namespace must not be adopted (B49).
    #[test]
    fn subjects_sa_matches_kind_name_and_namespace() {
        let subjects = |ns: &str| Some(vec![Subject {
            kind: "ServiceAccount".into(),
            name: "prometheus".into(),
            namespace: Some(ns.into()),
            api_group: None,
        }]);
        assert!(subjects_sa(subjects("panoptes").as_ref(), "panoptes", "prometheus"));
        assert!(!subjects_sa(subjects("other").as_ref(), "panoptes", "prometheus"));
        assert!(!subjects_sa(subjects("panoptes").as_ref(), "panoptes", "grafana"));
        // A User/Group subject never matches an SA name.
        let user = Some(vec![Subject { kind: "User".into(), name: "prometheus".into(), namespace: None, api_group: None }]);
        assert!(!subjects_sa(user.as_ref(), "panoptes", "prometheus"));
    }

    /// A pod with no references collects none — the section's empty note covers it.
    #[test]
    fn pod_without_references_collects_none() {
        let spec: PodSpec = serde_json::from_value(json!({
            "containers": [{ "name": "app" }],
        }))
        .unwrap();
        assert!(collect_pod_refs(&spec).is_empty());
    }

    /// The cert notAfter tone (B48): healthy reads secondary, under 30 days
    /// amber, expired red — the two cases worth seeing from the routing side.
    #[test]
    fn cert_tone_reflects_expiry() {
        let now = chrono::Utc::now();
        let healthy = now + chrono::Duration::days(90);
        let expiring = now + chrono::Duration::days(10);
        let expired = now - chrono::Duration::days(1);
        assert_eq!(cert_tone(&healthy.to_rfc3339(), now), Tone::Secondary);
        assert_eq!(cert_tone(&expiring.to_rfc3339(), now), Tone::Warn);
        assert_eq!(cert_tone(&expired.to_rfc3339(), now), Tone::Bad);
    }
}
