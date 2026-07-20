//! Row/Cell data-transfer types emitted to the frontend.
//!
//! These serialize to exactly the shape the TypeScript `Row`/`Cell` types expect
//! (see src/providers/types.ts). The backend owns all status *semantics*: it picks
//! a `Tone` per cell (e.g. CrashLoopBackOff → Err), and the frontend only maps
//! tone → a token color. This keeps coloring rules in one place.

use serde::Serialize;
use std::collections::BTreeMap;

/// The single coloring channel. Serializes to the lowercase strings the frontend
/// maps to token colors: "primary", "secondary", "muted", "ok", "warn", "err".
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    /// Names / primary emphasis (--text-primary).
    Primary,
    /// Metrics and general data (--text-secondary).
    Secondary,
    /// Namespace / age / de-emphasized (--text-muted).
    Muted,
    /// Healthy status (green). Renamed to "ok" for the frontend.
    #[serde(rename = "ok")]
    Good,
    /// Degraded / warning status (amber).
    Warn,
    /// Failed / error status (red). Renamed to "err" for the frontend.
    #[serde(rename = "err")]
    Bad,
}

/// A navigable target: the nav id plus the object's namespace/name, enough for
/// the frontend's `jumpTo` (B33). `kind` is a resolved nav id — a built-in plural
/// ("deployments") or a CRD "group/plural" — not a raw Kubernetes Kind.
///
/// Lives here rather than in `properties` because both a properties [`Field`] and
/// a table [`Cell`] can carry one: most references to another object show up in a
/// table (a pod's volumes, a Deployment's ReplicaSets), not in a field grid.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavTarget {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub name: String,
}

impl NavTarget {
    /// A target in `namespace`.
    pub fn namespaced(kind: &str, namespace: impl Into<String>, name: impl Into<String>) -> Self {
        NavTarget { kind: kind.into(), namespace: Some(namespace.into()), name: name.into() }
    }

    /// A cluster-scoped target (Nodes, PVs, StorageClasses).
    pub fn cluster(kind: &str, name: impl Into<String>) -> Self {
        NavTarget { kind: kind.into(), namespace: None, name: name.into() }
    }
}

/// A single table cell.
#[derive(Serialize, Clone, Debug)]
pub struct Cell {
    /// Display text, or an RFC3339 timestamp when `format == Some("age")`.
    pub text: String,
    pub tone: Tone,
    /// Render a leading "● " status dot in the tone color when true.
    /// Skipped in JSON when false to keep payloads small.
    #[serde(skip_serializing_if = "is_false")]
    pub dot: bool,
    /// When Some("age"), the frontend formats `text` (an ISO timestamp) as a
    /// k8s-style age and re-renders it on a tick.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<&'static str>,
    /// Optional numeric sort key for columns whose text isn't comparable
    /// (mirrors the frontend `Cell.sort`). Also used for backend-side default
    /// ordering, e.g. the Events feed sorts by last-seen epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<f64>,
    /// When set, this cell names another object and renders as a click-through
    /// link to it (B33/B40). Only the properties tables act on this; a list-table
    /// row already navigates by being clicked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav: Option<NavTarget>,
}

/// serde skip helper (serialize `dot` only when true).
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

impl Cell {
    /// A plain text cell with a tone.
    pub fn new(text: impl Into<String>, tone: Tone) -> Self {
        Cell { text: text.into(), tone, dot: false, format: None, sort: None, nav: None }
    }

    /// A status cell: tone + a leading colored dot.
    pub fn status(text: impl Into<String>, tone: Tone) -> Self {
        Cell { text: text.into(), tone, dot: true, format: None, sort: None, nav: None }
    }

    /// An age cell carrying an RFC3339 timestamp for the frontend to format.
    /// Empty timestamp → em dash (e.g. a resource with no creation time).
    pub fn age(creation_ts: Option<String>) -> Self {
        match creation_ts {
            Some(ts) if !ts.is_empty() => Cell {
                text: ts,
                tone: Tone::Muted,
                dot: false,
                format: Some("age"),
                sort: None,
                nav: None,
            },
            _ => Cell::new("—", Tone::Muted),
        }
    }

    /// Attach a numeric sort key (builder style).
    pub fn with_sort(mut self, key: f64) -> Self {
        self.sort = Some(key);
        self
    }

    /// Make this cell a link to another object (builder style).
    pub fn with_nav(mut self, target: NavTarget) -> Self {
        self.nav = Some(target);
        self
    }

    /// Link to `target` only when `name` is a real reference — an em dash or empty
    /// string means "nothing here", and a link to nothing is worse than plain text.
    pub fn link(text: impl Into<String>, tone: Tone, target: Option<NavTarget>) -> Self {
        let cell = Cell::new(text, tone);
        match target {
            Some(t) if cell.text != "—" && !cell.text.is_empty() => cell.with_nav(t),
            _ => cell,
        }
    }
}

/// The object an Event refers to (its `involvedObject`), threaded onto the event
/// row so the frontend can navigate to it (B33). `kind` + the group from
/// `api_version` resolve to a nav id — including CRDs, where the kind alone can
/// be ambiguous across groups.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InvolvedRef {
    /// Kubernetes Kind, e.g. "Pod", "Deployment", "Application".
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// apiVersion, e.g. "argoproj.io/v1alpha1". The group part disambiguates CRDs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
}

/// Extra fields carried only by pod rows, used to drive the detail panel.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PodMeta {
    pub node: String,
    pub containers: Vec<String>,
    pub status: String,
    pub ready: String,
    pub restarts: i32,
    /// RFC3339 creation timestamp (formatted into an age in the detail header).
    pub creation_ts: String,
    pub status_tone: Tone,
}

/// One row of a resource table. `cells` align 1:1 with the kind's column set
/// (see src/lib/kinds.ts — the column contract shared with the frontend).
#[derive(Serialize, Clone, Debug, Default)]
pub struct Row {
    /// Stable identity (k8s uid, falling back to namespace/name) for React keys
    /// and selection.
    pub uid: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub cells: Vec<Cell>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pod: Option<PodMeta>,
    /// Labels, for label-selector filtering (B33). Emitted for pods.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    /// A workload's pod selector (`matchLabels`), for the "view pods" jump (B33).
    /// Emitted for Deployments/StatefulSets/DaemonSets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<BTreeMap<String, String>>,
    /// For an Event row: the object it's about, for click-through (B33).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub involved: Option<InvolvedRef>,
}
