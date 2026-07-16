//! Row/Cell data-transfer types emitted to the frontend.
//!
//! These serialize to exactly the shape the TypeScript `Row`/`Cell` types expect
//! (see src/providers/types.ts). The backend owns all status *semantics*: it picks
//! a `Tone` per cell (e.g. CrashLoopBackOff → Err), and the frontend only maps
//! tone → a token color. This keeps coloring rules in one place.

use serde::Serialize;

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
}

/// serde skip helper (serialize `dot` only when true).
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

impl Cell {
    /// A plain text cell with a tone.
    pub fn new(text: impl Into<String>, tone: Tone) -> Self {
        Cell { text: text.into(), tone, dot: false, format: None, sort: None }
    }

    /// A status cell: tone + a leading colored dot.
    pub fn status(text: impl Into<String>, tone: Tone) -> Self {
        Cell { text: text.into(), tone, dot: true, format: None, sort: None }
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
            },
            _ => Cell::new("—", Tone::Muted),
        }
    }

    /// Attach a numeric sort key (builder style).
    pub fn with_sort(mut self, key: f64) -> Self {
        self.sort = Some(key);
        self
    }
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
#[derive(Serialize, Clone, Debug)]
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
}
