//! Pod log streaming.
//!
//! Each stream runs as an abortable task that follows a container's logs, parses
//! every line into `{ ts, level, msg }`, batches them (~80ms) to avoid IPC spam,
//! and emits `log-line:{streamId}`. On end/error it emits `log-closed:{streamId}`.
//! The parser (splitting the RFC3339 prefix and detecting a level) is unit-tested.

use super::events;
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use kube::Client;
use serde::Serialize;
use futures::{AsyncBufReadExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::time::{interval, Duration};

/// Flush cadence for batched log lines.
const FLUSH: Duration = Duration::from_millis(80);

/// A parsed log line sent to the frontend.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LogLine {
    /// "HH:MM:SS.mmm", or "" when no timestamp prefix was present.
    pub ts: String,
    /// Normalized level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "".
    pub level: &'static str,
    pub msg: String,
}

/// Batch payload for a `log-line:{id}` event.
#[derive(Serialize, Clone)]
struct LogBatch {
    lines: Vec<LogLine>,
}

/// Options mirrored from the frontend `LogOptions`.
#[derive(Default)]
pub struct LogStreamOptions {
    /// Seed with this many historical lines on first open.
    pub tail: Option<i64>,
    /// Resume from this time (used on un-pause), RFC3339.
    pub since_time: Option<String>,
}

/// Run a follow-log stream until the task is aborted or the stream ends.
///
/// Emits `log-line:{stream_id}` batches and a final `log-closed:{stream_id}`.
pub async fn run_log_stream(
    client: Client,
    app: AppHandle,
    stream_id: String,
    namespace: String,
    pod: String,
    container: String,
    opts: LogStreamOptions,
) {
    let closed_event = format!("{}{}", events::LOG_CLOSED_PREFIX, stream_id);
    match stream_inner(client, &app, &stream_id, &namespace, &pod, &container, opts).await {
        Ok(reason) => {
            let _ = app.emit(&closed_event, reason);
        }
        Err(e) => {
            // Surface the API error as the close reason so the UI can show it.
            let _ = app.emit(&closed_event, e.to_string());
        }
    }
}

/// Inner streaming loop; returns the close reason on normal end.
async fn stream_inner(
    client: Client,
    app: &AppHandle,
    stream_id: &str,
    namespace: &str,
    pod: &str,
    container: &str,
    opts: LogStreamOptions,
) -> AppResult<String> {
    let api: Api<Pod> = Api::namespaced(client, namespace);

    // Always request timestamps so we can render (and let the UI toggle) them.
    let mut lp = LogParams {
        follow: true,
        timestamps: true,
        container: Some(container.to_string()),
        ..Default::default()
    };
    lp.tail_lines = opts.tail;
    if let Some(ts) = &opts.since_time {
        // Parse the resume time; ignore a malformed value rather than failing.
        if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
            lp.since_time = Some(dt.with_timezone(&Utc));
        }
    }

    // log_stream yields a futures AsyncBufRead; .lines() turns it into a Stream of
    // io::Result<String>.
    let reader = api
        .log_stream(pod, &lp)
        .await
        .map_err(|e| AppError::Kube(e.to_string()))?;
    let mut lines = reader.lines();

    let line_event = format!("{}{}", events::LOG_LINE_PREFIX, stream_id);
    let mut batch: Vec<LogLine> = Vec::new();
    let mut flush = interval(FLUSH);

    loop {
        tokio::select! {
            // Next raw line (or end/error).
            next = lines.next() => match next {
                Some(Ok(raw)) => batch.push(parse_log_line(&raw)),
                None => {
                    // Stream ended cleanly; flush any tail and report.
                    if !batch.is_empty() {
                        let _ = app.emit(&line_event, LogBatch { lines: std::mem::take(&mut batch) });
                    }
                    return Ok("stream ended".to_string());
                }
                Some(Err(e)) => {
                    if !batch.is_empty() {
                        let _ = app.emit(&line_event, LogBatch { lines: std::mem::take(&mut batch) });
                    }
                    return Err(AppError::Kube(e.to_string()));
                }
            },
            // Periodic flush of whatever has accumulated.
            _ = flush.tick() => {
                if !batch.is_empty() {
                    let _ = app.emit(&line_event, LogBatch { lines: std::mem::take(&mut batch) });
                }
            }
        }
    }
}

/// Parse one raw log line (with a leading RFC3339 timestamp from `timestamps:true`)
/// into `{ ts, level, msg }`. Never drops content: an unparseable timestamp leaves
/// the whole line as the message with an empty ts.
pub fn parse_log_line(raw: &str) -> LogLine {
    // kube prefixes "<rfc3339> <message>"; split on the first space.
    let (ts, msg) = match raw.split_once(' ') {
        Some((maybe_ts, rest)) => match DateTime::parse_from_rfc3339(maybe_ts) {
            Ok(dt) => (dt.with_timezone(&Utc).format("%H:%M:%S%.3f").to_string(), rest),
            // No parseable timestamp: keep the whole line as the message.
            Err(_) => (String::new(), raw),
        },
        None => (String::new(), raw),
    };
    LogLine { ts, level: detect_level(msg), msg: msg.to_string() }
}

/// Detect a log level from the message: a JSON `"level"` field first, then a
/// word-boundary token scan of the head of the line. Returns "" if none found.
fn detect_level(msg: &str) -> &'static str {
    // Only inspect the head — levels appear near the start of a line.
    let head_len = msg.len().min(200);
    let head = &msg[..head_len];

    if let Some(l) = json_level(head) {
        return l;
    }

    let upper = head.to_ascii_uppercase();
    // Order matters: error-family first, then warn, info, debug/trace.
    const TOKENS: [(&str, &str); 8] = [
        ("PANIC", "ERROR"),
        ("FATAL", "ERROR"),
        ("ERROR", "ERROR"),
        ("ERR", "ERROR"),
        ("WARNING", "WARN"),
        ("WARN", "WARN"),
        ("INFO", "INFO"),
        ("DEBUG", "DEBUG"),
    ];
    for (needle, level) in TOKENS {
        if contains_word(&upper, needle) {
            return level;
        }
    }
    // TRACE maps to DEBUG (checked last so it can't shadow the others).
    if contains_word(&upper, "TRACE") {
        return "DEBUG";
    }
    ""
}

/// Extract a level from a JSON `"level":"…"` field if present.
fn json_level(head: &str) -> Option<&'static str> {
    let idx = head.find("\"level\"")?;
    // Find the value string after the colon.
    let after = &head[idx + 7..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(normalize_level(&rest[..end]))
}

/// Map an arbitrary level word to one of our four buckets (or "").
fn normalize_level(word: &str) -> &'static str {
    match word.to_ascii_uppercase().as_str() {
        "ERROR" | "ERR" | "FATAL" | "PANIC" | "CRITICAL" => "ERROR",
        "WARN" | "WARNING" => "WARN",
        "INFO" | "INFORMATION" | "NOTICE" => "INFO",
        "DEBUG" | "TRACE" | "VERBOSE" => "DEBUG",
        _ => "",
    }
}

/// True if `needle` appears in `haystack` bounded by non-alphanumeric characters
/// (so "ERROR" doesn't match inside "TERROR" and "ERR" doesn't match "ERROR").
fn contains_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let nlen = needle.len();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let i = start + pos;
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let after_idx = i + nlen;
        let after_ok = after_idx >= bytes.len() || !bytes[after_idx].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = i + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339_prefix_into_hms_millis() {
        let line = parse_log_line("2026-07-15T13:04:05.678901234Z hello world");
        assert_eq!(line.ts, "13:04:05.678");
        assert_eq!(line.msg, "hello world");
    }

    #[test]
    fn line_without_timestamp_keeps_full_message() {
        let line = parse_log_line("no timestamp here");
        assert_eq!(line.ts, "");
        assert_eq!(line.msg, "no timestamp here");
        assert_eq!(line.level, "");
    }

    #[test]
    fn detects_klog_style_levels() {
        assert_eq!(parse_log_line("2026-07-15T13:04:05Z INFO started ok").level, "INFO");
        assert_eq!(parse_log_line("2026-07-15T13:04:05Z ERROR boom").level, "ERROR");
        assert_eq!(parse_log_line("2026-07-15T13:04:05Z WARN careful").level, "WARN");
        assert_eq!(parse_log_line("2026-07-15T13:04:05Z DEBUG noisy").level, "DEBUG");
    }

    #[test]
    fn detects_json_level_field() {
        let l = parse_log_line(r#"2026-07-15T13:04:05Z {"level":"error","msg":"nope"}"#);
        assert_eq!(l.level, "ERROR");
        let w = parse_log_line(r#"2026-07-15T13:04:05Z {"ts":1,"level": "warning"}"#);
        assert_eq!(w.level, "WARN");
    }

    #[test]
    fn word_boundary_avoids_false_positives() {
        // "TERROR" should not be read as ERROR; "information" not as INFO-token
        // via boundaries (it still normalizes via json only). Here plain text:
        assert_eq!(detect_level("the TERROR of substrings"), "");
        assert_eq!(detect_level("reticulating splines"), "");
    }

    #[test]
    fn fatal_and_panic_map_to_error() {
        assert_eq!(detect_level("FATAL could not bind"), "ERROR");
        assert_eq!(detect_level("PANIC nil deref"), "ERROR");
        assert_eq!(detect_level("TRACE entering fn"), "DEBUG");
    }
}
