//! A deliberately small JSONPath subset (B30): dotted field access plus `[n]`
//! array indexing over `serde_json::Value`.
//!
//! CRDs declare their own table columns (`additionalPrinterColumns`) as JSONPath
//! expressions; this evaluator turns one into the text a row cell should show.
//! The subset covers every column freya's 44 CRDs declare — anything richer
//! (`[*]`, `[?(...)]`, recursive descent) is reported as unsupported rather than
//! silently mis-evaluated, and the caller renders it "—".

use serde_json::Value;

/// One step of a parsed path: a field lookup or an array index.
#[derive(Debug, PartialEq, Eq)]
enum Seg {
    Field(String),
    Index(usize),
}

/// The outcome of evaluating a printer column against one object.
#[derive(Debug, PartialEq, Eq)]
pub enum Eval {
    /// The path resolved to a scalar, rendered as its display string.
    Value(String),
    /// The path is valid but doesn't resolve on this object (e.g. a status
    /// field not yet set, or an index past the end). Renders "—" silently — a
    /// genuinely optional field is not a fault worth logging.
    Missing,
    /// The expression uses syntax the subset doesn't implement. Renders "—"
    /// and is logged once per path, because that's a gap in coverage a
    /// maintainer should hear about.
    Unsupported,
}

/// Evaluate `path` against `value`, a kubectl-style JSONPath like
/// `.status.sync.status`, `{.status.health.status}`, or `.items[0].name`.
pub fn eval(path: &str, value: &Value) -> Eval {
    let Some(segs) = parse(path) else {
        return Eval::Unsupported;
    };
    let mut cur = value;
    for seg in &segs {
        cur = match seg {
            Seg::Field(name) => match cur.get(name) {
                Some(v) => v,
                None => return Eval::Missing,
            },
            Seg::Index(i) => match cur.get(*i) {
                Some(v) => v,
                None => return Eval::Missing,
            },
        };
    }
    match render(cur) {
        // An object/array/`null` result has no single display value; treat it
        // the same as a miss rather than dumping JSON into a cell.
        Some(text) => Eval::Value(text),
        None => Eval::Missing,
    }
}

/// Tokenize a path into field/index segments. Returns None for syntax the
/// subset doesn't cover (`[*]`, `[?(...)]`), so an unsupported expression
/// fails loudly once rather than dropping a step and mis-resolving.
fn parse(path: &str) -> Option<Vec<Seg>> {
    let s = path.trim();
    // kubectl writes columns both as `{.a.b}` and `.a.b`; also tolerate `$`.
    let s = s.strip_prefix('{').and_then(|t| t.strip_suffix('}')).unwrap_or(s);
    let s = s.trim_start_matches('$');

    let bytes = s.as_bytes();
    let mut segs = Vec::new();
    let mut field = String::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'.' => {
                if !field.is_empty() {
                    segs.push(Seg::Field(std::mem::take(&mut field)));
                }
                i += 1;
            }
            b'[' => {
                if !field.is_empty() {
                    segs.push(Seg::Field(std::mem::take(&mut field)));
                }
                i += 1;
                let start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if start == i || i >= bytes.len() || bytes[i] != b']' {
                    // `[*]`, `[?()]`, `["key"]` — none supported.
                    return None;
                }
                segs.push(Seg::Index(s[start..i].parse().ok()?));
                i += 1; // consume ']'
            }
            c => {
                field.push(c as char);
                i += 1;
            }
        }
    }
    if !field.is_empty() {
        segs.push(Seg::Field(field));
    }
    Some(segs)
}

/// Render a resolved value to its display string; None when there isn't one
/// (null, or a subtree).
fn render(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Object(_) | Value::Array(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Mirrors an Argo CD Application object, whose CRD declares Sync Status
    /// and Health Status columns (`.status.sync.status` / `.status.health.status`)
    /// plus the array-index case a `[0]` column would use.
    fn app() -> Value {
        json!({
            "metadata": { "name": "valkyrie", "creationTimestamp": "2026-08-01T12:00:00Z" },
            "spec": { "replicas": 3, "enabled": true, "destination": null },
            "status": {
                "sync": { "status": "Synced", "revision": "abc123" },
                "health": { "status": "Healthy" },
                "conditions": [ { "type": "Deployed", "status": "True" } ],
            },
            "items": [ { "name": "first" }, { "name": "second" } ],
        })
    }

    /// The exact expressions the Argo Application CRD declares (B30): dotted
    /// field access through nested objects.
    #[test]
    fn dotted_field_access() {
        assert_eq!(eval(".status.sync.status", &app()), Eval::Value("Synced".into()));
        assert_eq!(eval(".status.health.status", &app()), Eval::Value("Healthy".into()));
    }

    /// kubectl also accepts the braced `{.a.b}` form and a leading `$`.
    #[test]
    fn braced_and_dollar_forms() {
        assert_eq!(eval("{.status.sync.revision}", &app()), Eval::Value("abc123".into()));
        assert_eq!(eval("$.status.sync.status", &app()), Eval::Value("Synced".into()));
    }

    /// `[n]` picks one element of an array.
    #[test]
    fn array_index() {
        assert_eq!(eval(".items[1].name", &app()), Eval::Value("second".into()));
        assert_eq!(eval(".status.conditions[0].type", &app()), Eval::Value("Deployed".into()));
    }

    /// Numbers and booleans render as their string forms.
    #[test]
    fn scalar_rendering() {
        assert_eq!(eval(".spec.replicas", &app()), Eval::Value("3".into()));
        assert_eq!(eval(".spec.enabled", &app()), Eval::Value("true".into()));
    }

    /// A field that isn't there (a status not yet set) is a silent miss, not a
    /// logged fault.
    #[test]
    fn missing_field_is_a_silent_miss() {
        assert_eq!(eval(".status.nope", &app()), Eval::Missing);
        assert_eq!(eval(".status.sync.status.deep", &app()), Eval::Missing);
    }

    /// An index past the end of an array is a miss too.
    #[test]
    fn index_out_of_range() {
        assert_eq!(eval(".items[9].name", &app()), Eval::Missing);
    }

    /// A `null` value or a resolved subtree has no single display value.
    #[test]
    fn null_and_subtrees_are_misses() {
        assert_eq!(eval(".spec.destination", &app()), Eval::Missing);
        assert_eq!(eval(".status.sync", &app()), Eval::Missing);
    }

    /// Wildcards and filters are the gap in the subset; they must report
    /// unsupported rather than mis-resolve.
    #[test]
    fn unsupported_syntax_is_flagged() {
        assert_eq!(eval(".items[*].name", &app()), Eval::Unsupported);
        assert_eq!(eval(".status[?(@.phase=='Running')]", &app()), Eval::Unsupported);
        assert_eq!(eval(".status.conditions[0:1]", &app()), Eval::Unsupported);
    }

    /// An empty expression resolves to the whole object, which is not a scalar.
    #[test]
    fn empty_path_is_a_miss() {
        assert_eq!(eval("", &app()), Eval::Missing);
    }
}
