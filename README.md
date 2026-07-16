# k7s

A dark, Lens-style **Kubernetes visual monitor** built as a [Tauri](https://tauri.app) desktop app — a Rust backend talking to the Kubernetes API, with a React + TypeScript frontend that recreates the design in [`design/`](design/).

Left navigation over all common resource kinds, live resource tables with namespace filtering, and a pod detail panel with **streaming logs**, **YAML view/edit/apply**, and **Events**.

> Design source of truth: [`design/README.md`](design/README.md) (exact tokens/spacing) and the interactive prototype [`design/K8s Monitor.dc.html`](design/). See [`plan.md`](plan.md) for architecture and [`tasks.md`](tasks.md) for the epic/story breakdown.

## Features

- **Cluster switcher** fed by your kubeconfig contexts; switching tears down and rebuilds all live streams. **Import kubeconfig** adds contexts from any kubeconfig file via a native file picker (defaulted to kubectl's `~/.kube/config`), and they connect via their source file.
- **12 resource kinds** watched live — Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, Secrets, Nodes, Namespaces — with sidebar counts and a "watch: N streams active" footer.
- **Resource tables** with per-kind columns, namespace filtering, and status coloring driven by the backend.
- **Pod detail panel**: follow/pause **log streaming** (container cycler, timestamp toggle, client-side search, 200-line ring buffer), **YAML** view with a CodeMirror editor and apply-to-cluster, and **Events**.
- **Status bar** with API latency, nodes ready, and cluster CPU/MEM % (via `metrics.k8s.io`, degrading to `—` when metrics-server is absent).

## Prerequisites

- **Node** ≥ 20 and npm
- **Rust** (stable) + the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for your OS
- A working **kubeconfig** to run against a real cluster (optional — see demo mode)
- For the fixture cluster: [`kind`](https://kind.sigs.k8s.io/) + `kubectl`

## Getting started

```bash
npm install

# Demo mode — runs the whole UI in a plain browser with the prototype's mock data,
# no cluster or Rust build needed. Best for UI work / pixel comparison.
VITE_DEMO=1 npm run dev        # → http://localhost:1420

# Same, but with the pods table padded out to 5000 synthetic rows — the fixture
# for checking that large tables still scroll smoothly (B21).
VITE_DEMO=1 VITE_STRESS=5000 npm run dev

# Real app — Rust backend + webview against your current kubeconfig context.
dev/run.sh                     # preferred; see below
npm run tauri:dev              # raw equivalent
```

### `dev/run.sh` — why not just `npm run tauri:dev`?

Because `tauri dev` can silently show you a **stale build**. It serves the webview
from `devUrl` (localhost:1420), but `tauri.conf.json` also declares
`frontendDist: "../dist"`. If vite isn't actually up on 1420 — a previous run left
an orphan holding the port, or vite died — the window can come up rendering
whatever `npm run build` last produced. It looks like the app, with features
mysteriously missing. We lost real time to this twice: it reads as "my code is
broken" when in fact your code was never loaded.

`dev/run.sh` makes that state unreachable. It stops any previous k7s dev
processes (matched to *this* repo — it will never touch another project's vite),
refuses to start if something else owns port 1420 rather than killing a stranger,
deletes `dist/` so there's nothing stale to fall back to, and watches vite for as
long as the app runs — if vite dies, it says so and stops the app instead of
leaving you debugging a ghost.

```bash
dev/run.sh                                   # current kubeconfig context
KUBECONFIG=/path/to/kubeconfig dev/run.sh    # a specific one
```

### Demo mode vs. real mode

The frontend talks to a `DataProvider` interface with two implementations
(`src/providers/`): a **MockProvider** (demo mode, `VITE_DEMO=1`) that replays the
prototype's data, and a **TauriProvider** that invokes the Rust backend. Components
never reference either directly, so the entire UI can be developed and pixel-checked
against the design without a cluster.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `↓`, `k` / `↑` | Move the row highlight down / up |
| `Enter` | Open the highlighted row's detail |
| `g g` / `G` | Jump to the first / last row |
| `/` | Focus the table filter |
| `Esc` | Close an open menu → else clear the filter → else close the detail panel |
| `[` / `]` | Cycle the detail panel's tabs |

Shortcuts are ignored while typing in a field (filter, log search, YAML editor).

## Fixture cluster

To exercise the real backend end-to-end, bring up a local `kind` cluster seeded with
a realistic spread of workloads (including a CrashLoopBackOff pod, a Pending pod, and
a chatty multi-format logger):

```bash
./dev/cluster/up.sh              # create cluster + apply manifests
./dev/cluster/up.sh --metrics    # ...also install metrics-server (CPU/MEM columns)
npm run tauri:dev                # launch against context kind-k7s-dev
./dev/cluster/down.sh            # tear it all down
```

## Testing

```bash
npm run typecheck                          # tsc --noEmit
npm test                                   # vitest (formatters, store/ring buffer)
cargo test  --manifest-path src-tauri/Cargo.toml   # DTO mapping, log parser, quantities
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Build

```bash
npm run tauri:build              # produces a native app/installer under src-tauri/target
```

Output: `src-tauri/target/release/bundle/macos/k7s.app` (and a `.dmg`). The Tauri
window background is set to `#0d0d0f` and fonts are bundled locally, so the app
launches dark with no white flash and needs no network at startup. Launching without
a kubeconfig lands in a clean disconnected state.

> Note: the final `.dmg` styling step (`bundle_dmg.sh`) drives Finder/AppleScript
> and requires a logged-in GUI session — it fails in headless/CI environments even
> though the `.app` bundle itself builds fine. Build on a desktop session (or ship
> the `.app`) to get the `.dmg`.

## Project layout

```
design/                 # handoff (source of truth) — README + interactive prototype
plan.md · tasks.md      # architecture + epic/story breakdown
src/                    # React frontend
  providers/            #   DataProvider interface + Mock/Tauri implementations
  components/           #   sidebar · topbar · table · detail · statusbar
  store.ts · lib/       #   Zustand store, formatters, kind metadata, tone→color
src-tauri/              # Rust backend
  src/kube/             #   client · manager · watchers · mappers · logs · metrics
  src/commands.rs       #   Tauri commands (connect, get_yaml, start_log_stream, …)
dev/cluster/            # kind config + fixture manifests + up/down scripts
```

## Architecture at a glance

The Rust backend holds one active `kube::Client` and a registry of connection-scoped
tasks: one `watcher`/reflector per kind (emitting debounced row snapshots), a
metrics + status poller, and per-pod log streams. All are aborted on disconnect or
context switch. The frontend subscribes to Tauri events (`resource-update`,
`pod-metrics`, `cluster-status`, `watch-status`, `log-line:{id}`) and invokes
commands for one-shot operations. Status/coloring semantics live in the backend
(each cell carries a `tone`); the frontend maps tone → a design token. See
[`plan.md`](plan.md) for the full picture.
