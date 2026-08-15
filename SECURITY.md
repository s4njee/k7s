# Security

k7s holds your cluster credentials, so its own posture matters. This page is
what a platform team's security review should read first.

## Security posture

- **No telemetry, ever.** k7s sends nothing to any server it doesn't belong to.
  The only outbound calls are: the Kubernetes API you configured, the update
  endpoint you publish to (`releases/latest/download/latest.json`, B72), and
  the crash-report endpoint if you explicitly turn crash reporting on (B73) —
  which sends panics and render errors only. There is no usage analytics. The
  README says this as a feature.
- **Minimal webview permissions.** The Tauri capability set
  (`src-tauri/capabilities/default.json`) grants only what the frontend
  provably uses — `invoke`/`listen`/`getVersion`, the window surface, file
  dialogs, shell-open, window-state, updater, process relaunch. No
  path/image/resources/menu/tray permissions (B75).
- **Content Security Policy.** The webview runs under a real CSP
  (`src-tauri/tauri.conf.json`): `default-src 'self'`, no remote scripts or
  objects, `frame-ancestors 'none'`. `style-src 'unsafe-inline'` is the
  deliberate carve-out CodeMirror/xterm/plotly need. Tauri additionally hashes
  the app's own scripts at build time.
- **Cluster data is rendered as text.** Everything the cluster supplies — log
  lines, event messages, CRD column values — is rendered through React's
  default text escaping. There is no `dangerouslySetInnerHTML` in the app, and
  a regression test pins a hostile pod name rendering as text (B75).
- **Secrets stay out of diagnostics.** The "Export diagnostics" bundle is
  scrubbed of server URLs, bearer tokens, base64 blobs and paths before it's
  written, so a bug report can't leak the cluster's identity (B73).

## Reporting a vulnerability

Please report security issues privately — do not open a public issue.

**Contact:** [sanjee.yogeswaran@gmail.com](mailto:sanjee.yogeswaran@gmail.com)

Include:

- a description of the issue and how to reproduce it,
- the affected version(s),
- whether you've confirmed it on macOS, Linux and/or Windows,
- any proof-of-concept (redacted — don't include real cluster credentials).

You should get an acknowledgement within a few days. We'll work with you on a
fix and coordinate disclosure. Public disclosure happens only after a fix is
released and communicated; if you'd prefer to disclose on a particular schedule,
say so and we'll do our best to match it.

## Supported versions

Security fixes are applied to the **latest release** line. If you're on an
older version, update before reporting — the fix may already be in the current
release.

## Scope

In scope: the Tauri/Rust backend, the webview and its permissions/CSP, and the
update pipeline. Out of scope: the Kubernetes API server itself, the clusters
you connect to, and anything a compromised cluster already controls — remember
that cluster-supplied strings are attacker-influenced input by design, which is
why the app treats them as text.
