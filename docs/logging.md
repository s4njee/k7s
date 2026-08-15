# Logging & diagnostics

How k7s logs, where the logs live, how to read them, and how the "Export
diagnostics" bundle and opt-in crash reporting fit in. Built in [B73](../../backlog-v6.md);
the changelog entry is in [CHANGELOG.md](../CHANGELOG.md).

The short version: **everything the app logs lands in a rotating text file in the
platform app-log directory, and File → Export Diagnostics… (⌘⇧E) packages a
scrubbed copy for a bug report.** A user never needs a terminal.

---

## What's in place

### Two sinks, one stream

`src-tauri/src/logging.rs` installs a `tracing` subscriber at startup with a
single reloadable filter feeding **stderr** (dev convenience) and a **rotating
file** under the platform app-log directory. Every `tracing::` call — and every
panic and forwarded frontend error — reaches both.

| Sink | Purpose |
|---|---|
| stderr | Dev: `dev/run.sh` / `npm run tauri:dev` shows it in the terminal |
| file (`k7s.YYYY-MM-DD.log`) | Support: what a bundled app user can attach to a report |

The file side is best-effort: no app-log dir, or one that can't be opened, means
stderr only and a line saying so — logging never prevents startup.

### Where the file lives

The file is `k7s.YYYY-MM-DD.log`, rotated **daily** with **at most 5 files**
kept. The directory is Tauri's `app_log_dir()`
([`BaseDirectory::AppLog`](https://docs.rs/tauri/latest/tauri/path/enum.BaseDirectory.html)):

| Platform | Directory |
|---|---|
| macOS | `~/Library/Logs/io.k7s.app/` |
| Linux | `~/.config/io.k7s.app/logs/` (or `$XDG_CONFIG_HOME` if set) |
| Windows | `%APPDATA%\io.k7s.app\logs\` |

Example file on macOS: `~/Library/Logs/io.k7s.app/k7s.2026-08-14.log`

### Levels

`error` < `warn` < `info` < `debug` < `trace`. Default is **info**.

- **Settings → Diagnostics → Log level** changes it live (the filter is
  reloaded without a restart) and persists in `prefs.json`.
- **`RUST_LOG`** (dev only) overrides the setting at boot. The packaged app has
  no env var to set, so the Settings control is the knob there.
- A hand-edited `prefs.json` can't smuggle in a junk level — the backend rejects
  anything outside the five.

The app's own code logs at `warn` today (watcher errors, failed probes, dropped
imports); `debug`/`trace` are for future instrumentation and for third-party
crates (kube logs request URLs at `debug` — see the redaction note below).

### Frontend errors reach the log

`src/lib/diagnostics.ts` + `main.tsx` + `src/components/ErrorBoundary.tsx`
forward three sources to the backend command `log_frontend_error`, which writes
them to the same log:

- `window` — an uncaught `window` error
- `unhandledrejection` — a promise rejection nothing handled
- `error-boundary` — a React render error (the boundary also keeps the stack for
  export, and shows "Export diagnostics" right on the error screen)

All three include the stack when one exists.

### Export diagnostics (⌘⇧E)

Triggered from **File → Export Diagnostics…**, the Settings Diagnostics section,
or the ErrorBoundary screen. It opens a native save dialog, then the backend
(`export_diagnostics` → `diagnostics.rs`) zips:

| Entry | Contents |
|---|---|
| `k7s.log` | the last 2 MB of the newest log file |
| `versions.json` | app version, OS, arch, connected context/cluster **names**, current log level |
| `settings.json` | persisted prefs with **paths and context names redacted** |
| `boundary.txt` | the last ErrorBoundary trace, when there was one |

Everything is run through `diagnostics::redact` before writing: **server URLs,
`Bearer` tokens, long base64 blobs (cert data), and your home path** are
replaced with `<redacted>`. The bundle is deliberately shareable — it never
contains kubeconfig contents, tokens, secret values or server URLs. The
verification steps are in [`verification.md`](verification.md).

### Opt-in crash reporting

`src-tauri/src/crash_reporting.rs`:

- A **panic hook** is installed at startup. It *always* writes the panic + a
  forced backtrace to the log file (that's diagnostics, unconditional). It only
  **POSTs** a report when reporting is armed.
- **Frontend errors** (the same three sources) can be reported too.
- Arming = **Settings → Diagnostics → Crash reporting = on** *and* an endpoint
  set (Sentry or self-hosted GlitchTip ingestion URL). Empty endpoint means
  nothing is ever sent, even with consent on.
- Reports are panics + render errors **only** — no analytics, no usage
  telemetry, ever; the README says so as a feature.
- When off (the default), `report` returns before an HTTP client is even built
  — zero network calls, pinned by a unit test.

---

## Where to start debugging

**Step 0 — get the log.** Find the file per the table above and `tail` it, or
use File → Export Diagnostics… and open `k7s.log` in the zip.

**Step 1 — make it talkative.** If `info` isn't enough: Settings → Diagnostics →
Log level → `debug` (applies immediately). For a one-off dev run,
`RUST_LOG=debug dev/run.sh` does the same via stderr.

**Step 2 — match the symptom to the source:**

| Symptom | Where to look in the log |
|---|---|
| App won't start / crashed | a `panic:` line with a backtrace (the panic hook catches *any* thread's panic, watchers included) |
| Blank or broken UI | `frontend error-boundary:` — the render error + stack; also `boundary.txt` in the export |
| Something throws outside React | `frontend window:` / `frontend unhandledrejection:` |
| A table stops updating | `watch … error` (the watcher logged it before going into backoff) |
| No CPU/MEM columns | `metrics.k8s.io unavailable` / `cluster status probe failed` |
| Nothing is being logged at all | check stderr for the "logging to stderr only" fallback — the file layer couldn't open a dir |

**Step 3 — read a line.** The format is the standard `tracing` fmt layer:
`TIMESTAMP LEVEL target: message`. The `target` tells you the module — `k7s_lib`,
`frontend`, `panic` — so grep by it.

**Step 4 — make it reproducible.** A debug-level capture is usually enough. If
the bug is a crash, the panic backtrace is already there. If it's a render error
and you want to hand it to someone, **Export Diagnostics** and attach the zip —
the redaction pass means it's safe to paste anywhere.

### Gotchas

- **Level changes are global.** `debug` also turns on kube's own logs, which
  include request URLs. They're fine in the file (it's local), and scrubbed on
  export — but if you're copying raw lines to a chat, redact manually or export
  instead.
- **`RUST_LOG` beats the setting** in dev, so a stale `RUST_LOG` can make the
  Settings control look broken. Unset it to test the setting.
- **Daily rotation, not size.** A very chatty `debug` session can produce a
  large file before midnight; the export only takes the last 2 MB, so that's the
  part that matters.
- **The panic hook replaces the default.** The panic is still logged (with a
  backtrace) and the process still aborts — it's just that the message goes
  through `tracing`, not the default stderr printer, so **always** check the log
  file if the app died.

---

## To Do: expand unified logging

The pieces above are the foundation; these are the directions that would make
logging a first-class surface. (Most are also flagged in the backlog/parking
lot.)

1. **Structured (JSON) file layer.** Today the file is the human `fmt` format.
   A second `json`-formatted writer would let a support script `jq` the log
   (levels, targets, fields) instead of regex-grepping text. Cheap: one more
   `fmt::layer().json()` into the same filter.

2. **Size-based rotation / retention.** `tracing-appender` rotates by time;
   `debug` can bloat a day's file. A size cap (or a retention setting in
   Settings) would bound disk the way the export already bounds the tail.

3. **Webview console into the same log.** `console.log`/`console.warn` from the
   frontend currently go nowhere the user can see. Bridging them to
   `log_frontend_error`-style commands (with a source tag) would unify
   frontend+backend logging into one file — the `tauri-plugin-log` crate is the
   conventional route.

4. **`tracing` spans, not just events.** Commands and watchers are `warn!`/`error!`
   events today. Wrapping connection, watch and apply flows in spans would give a
   bug report the *flow* ("connect → watch pods → error") instead of isolated
   lines. This is the biggest leap in usefulness per line of code.

5. **In-app log viewer.** A Diagnostics tab that tails the live file (via a
   `tail`-style command) so a user can watch their own log without exporting —
   useful for self-serve troubleshooting and for support calls.

6. **One-click export from the ErrorBoundary is done**; the next step is *auto*-
   suggesting the export (or offering to attach it to a copied bug template) when
   a render error happens.

7. **Log retention in Settings.** Expose `max_log_files` (currently a constant
   `5`) and the exported tail size as Settings knobs.

8. **Test the file layer in CI.** The acceptance tests (log file gets panics;
   the zip greps clean; crash reporting stays silent when off) are documented
   but manual. Wiring them into B83's e2e harness would make B73's guarantees
   regression-proof.

9. **Request-level tracing with redaction built in.** kube's `debug` URLs are
   scrubbed only at export time. A `tracing`-level middleware that logs
   scrubbed request summaries (status, latency, no URLs) would make `info` a
   genuinely useful audit trail rather than a silent default.
