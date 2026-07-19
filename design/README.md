# Handoff: K8s Monitor ("freya") — Tauri + Rust desktop app

## Overview
A Kubernetes cluster monitor in the spirit of Lens: left navigation over all common resource kinds, resource tables with namespace filtering, and a pod detail panel with **streaming logs**, **YAML view/edit**, and **Events**. Target implementation: a **Tauri desktop app** — Rust backend talking to the Kubernetes API, webview frontend recreating this design.

## About the Design Files
`K8s Monitor.dc.html` in this bundle is a **design reference created in HTML** — a prototype showing intended look and behavior, not production code to copy directly. The task is to **recreate this design in a Tauri app**: build the frontend in the framework of your choice (React + Vite is a good default for Tauri) and implement real data via Rust.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interactions are final. Recreate pixel-perfectly. All styling values below are exact.

## Suggested Tauri/Rust architecture
- **Rust side (src-tauri):** use [`kube`](https://crates.io/crates/kube) + `k8s-openapi` crates.
  - Kubeconfig contexts → cluster switcher entries (`kube::config::Kubeconfig::read()`).
  - List/watch each resource kind with `kube::runtime::watcher`; push updates to the frontend via Tauri **events** (`app.emit`) — this powers live table counts and the "watch: N streams active" footer.
  - Logs: `Api::<Pod>::log_stream` with `LogParams { follow: true, container, timestamps }`; forward lines as Tauri events (`log-line:{pod}`); cancel the stream task on pause/close.
  - YAML: `serde_yaml::to_string` of the fetched object; Apply = `Api::replace` (or server-side apply) from the edited text; report errors back to the UI.
  - Events tab: `Api::<Event>::list` field-selected by `involvedObject.name`.
- **Frontend:** invoke commands (`list_resources`, `get_yaml`, `apply_yaml`, `start_log_stream`, `stop_log_stream`) + listen to events. Keep a capped ring buffer (default 200 lines) for logs.
- Window: frameless optional; min size ~1280×800. Everything is dark; set the Tauri window background to `#0d0d0f` to avoid white flash.

## Screens / Views

### App shell (single window)
Horizontal flex, full viewport, `background:#0d0d0f`, text `#d2d2d8`, base font `13px 'IBM Plex Sans'`. Monospace: `'JetBrains Mono'` (both from Google Fonts; bundle locally in Tauri).

### 1. Sidebar — 216px fixed, `background:#121214`, right border `1px #26262b`
- **Cluster switcher** (top, own row, bottom border `#26262b`): button `background:#17171a; border:1px #2e2e34; radius:6px; padding:8px 10px`. Contains a 24×24 badge (`background:#34343c; radius:5px`, mono 11px bold `#d2d2d8`, initials "FR"), cluster name (12.5px semibold `#ececf1`), status line (mono 10.5px `#70707a`: green 6px dot `#9ece6a` + "connected · v1.31"), and a 9px `▼`. Clicking opens a dropdown (absolute, `background:#17171a; border:1px #38383f; radius:6px; shadow 0 8px 24px rgba(0,0,0,.5)`) listing kubeconfig contexts: dot (green `#9ece6a` if current, else `#57575f`), name 12.5px `#ececf1`, env tag mono 10px `#70707a`. Active row bg `#1b1b1f`; hover `#222227`.
- **Nav** (scrollable): section headers mono 10px uppercase `letter-spacing:.12em` color `#57575f` — Workloads, Network, Config, Cluster. Items (Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs / Services, Ingresses / ConfigMaps, Secrets / Nodes, Namespaces): row `margin:1px 8px; padding:5px 8px; radius:5px`, glyph icon 11px, label 12.5px, right-aligned live count mono 10.5px `#70707a`. **Active state:** bg `#16233a`, 2px left border `#4d9fff`, label `#ececf1`, icon `#4d9fff`. Inactive: label `#8e8e98`, icon `#57575f`, hover bg `#1b1b1f`.
- **Footer**: top border `#26262b`, mono 10.5px `#70707a`: pulsing 6px dot `#8e8e98` (2s opacity pulse) + "watch: 9 streams active" (make N = live watcher count).

### 2. Top bar — 46px, `background:#101012`, bottom border `#26262b`
- Left: breadcrumb mono 12px — `freya / <group> / <Kind>`; separators `#3a3a42`, kind `#ececf1` semibold, rest `#70707a`.
- Right: **namespace dropdown** — button `padding:4px 10px; background:#17171a; border:1px #26262b; radius:5px`, mono 11px: `ns:` in `#57575f`, current value `#ececf1`, 8px `▼`. Menu: absolute right-aligned, min-width 170px, same chrome as cluster menu, rows mono 11px with a blue `✓` (`#4d9fff`) on the selected namespace. Options: all + live namespace list.

### 3. Resource table (fills remaining width, scrolls)
- Mono 11.5px. Sticky header row: bg `#101012`, 10px uppercase `letter-spacing:.1em` `#57575f`, bottom border `#26262b`, `padding:8px 14px`.
- Cells `padding:6px 14px`, row bottom border `#1b1b1f`, `white-space:nowrap`. Row hover `#17171a`; selected pod row `#122036`.
- Column sets: Pods = NAME, NAMESPACE, READY, RESTARTS, CPU, MEM, AGE, STATUS. Others per kind (see prototype).
- Cell colors: names `#ececf1`; namespace/age `#70707a`; metrics `#a4a4ae`; STATUS prefixed with `● ` colored — Running/Ready/Active `#9ece6a`, Pending `#e0af68`, CrashLoopBackOff/failed `#f7768e`. READY like `1/2` and restarts > 5 highlight `#e0af68` / `#f7768e`.
- Empty filter result: centered mono 12px `#57575f` — "no resources match filter".

### 4. Pod detail panel — 47% width (min 520px), left border `#26262b`, `background:#101012`
Opens when a pod row is clicked; `×` button (24px square, hover bg `#222227`) closes it.
- **Header**: 8px status dot + pod name mono 13px semibold `#ececf1` (ellipsized); meta row mono 10.5px `#70707a` with values `#a4a4ae`: `ns:`, `node:`, `age:`, and status word in its status color.
- **Tabs**: Logs / YAML / Events — 12px medium, `padding:7px 14px`, active `#ececf1` with 2px bottom border `#4d9fff`; inactive `#70707a`.

#### Logs tab
- Toolbar (8px 14px, bottom border `#1b1b1f`): search field (flex-1, `background:#0a0a0c; border:1px #26262b; radius:5px`, mono 11px, placeholder "filter logs…", `⌕` prefix); container cycler button (mono 10.5px `#a4a4ae`, shows current container, cycles through pod containers); `ts` toggle (active: border+text `#4d9fff`); follow/pause button — following: `⏸ pause`, green `#9ece6a` text, border `#3a5f35`, bg `#122015`; paused: `▶ follow`, amber `#e0af68`, border `#5a4a2a`, bg `#1f1a10`.
- Log area: `background:#0a0a0c`, mono 11px, line-height 1.65, row hover `#151519`. Each line: timestamp `HH:MM:SS.mmm` `#4c4c55` (hidden when ts off) · level (42px col, semibold) — INFO `#4d9fff`, WARN `#e0af68`, ERROR `#f7768e`, DEBUG `#70707a` · message — default `#a4a4ae`, ERROR lines `#f2a5b3`, WARN lines `#d8c39a`.
- Behavior: auto-scroll to bottom while following; pausing stops the stream (and auto-scroll); search filters client-side; ring buffer caps lines (default 200, configurable).
- Footer strip: mono 10px `#57575f` — line count, container name, `● streaming` (green) / `⏸ paused` (amber).

#### YAML tab
- Toolbar: resource path mono 10.5px `#70707a` (`pods/<ns>/<name>.yaml`); right: read mode → `✎ Edit` button (11px, text `#4d9fff`, border `#2a4a75`, hover bg `#12203a`); edit mode → `Cancel` (ghost, border `#26262b`) + `Apply ⏎` (bg `#4d9fff`, text `#0d0d0f`, semibold, hover `#7db8ff`).
- Read mode: `background:#0a0a0c`, mono 11.5px, line-height 1.6; line numbers right-aligned 30px `#34343c`; keys `#a4a4ae`, colon `#70707a`, values `#d2d2d8`, quoted strings `#9ece6a`, numbers `#e0af68`. (In production use a real YAML highlighter, e.g. CodeMirror with a dark theme matched to these colors.)
- Edit mode: full-height textarea/CodeMirror, same bg/font, 3px left border `#4d9fff`. Apply → PUT to cluster; surface API errors inline.

#### Events tab
- Vertical list, 8px gap. Card: `background:#121214; border:1px #26262b; radius:6px; padding:9px 12px`. Left: type mono 10px semibold, 52px col — Normal `#9ece6a`, Warning `#f7768e`. Right: reason 12px semibold `#ececf1` + age/count mono 10px `#57575f` (`2m · ×14`), message 11.5px `#a4a4ae`.

### 5. Status bar — 26px, `background:#121214`, top border `#26262b`
Mono 10px `#70707a`: `● freya` (green), api latency, nodes ready, cpu %, mem %; right-aligned `kubectl ctx: <context>`.

## Interactions & Behavior
- Nav click switches resource kind, clears selection. Pod row click opens detail (re-seeds log stream). Only pods open the detail panel in the prototype; extending YAML/Events to all kinds is a natural follow-up.
- Dropdowns (cluster, namespace) close on selection; only one open at a time.
- Log stream: new line ~every 900ms in the prototype; real app streams from the API. Pause must halt both stream consumption and auto-scroll.
- No animations besides the 2s opacity pulse on "live" dots; hovers are instant background/border changes.

## State Management
`selectedCluster, nav (resource kind), namespace filter, selectedPod, activeTab (logs|yaml|events), logSearch, containerIndex, showTimestamps, following, logBuffer[], yamlEditing, yamlDraft, menusOpen`. Data: per-kind watched resource lists, pod events, YAML text.

## Design Tokens
- **Backgrounds:** app `#0d0d0f` · panel `#121214` · header/table chrome `#101012` · control `#17171a` · terminal/log/yaml `#0a0a0c` · hover `#1b1b1f`/`#222227` · selected row `#122036` · active nav `#16233a`
- **Borders:** default `#26262b` · control `#2e2e34` · menu `#38383f` · hover `#4a4a55` · blue action `#2a4a75`
- **Text:** primary `#ececf1` · body `#d2d2d8` · secondary `#a4a4ae` · muted `#70707a` · faint `#57575f` · line numbers `#34343c`
- **Accent:** blue `#4d9fff` (hover `#7db8ff`) — active indicators + primary actions only
- **Semantic:** green `#9ece6a` · amber `#e0af68` · red `#f7768e` (soft msg tints `#d8c39a`, `#f2a5b3`)
- **Type:** `IBM Plex Sans` (UI) + `JetBrains Mono` (data/code); sizes 10–13px; radius 5–6px; borders 1px.

## Assets
No images. Icons are unicode glyphs (`◉ ▲ ≡ ⦿ ▸ ↻ ⇄ ⇥ ☰ ⚿ ▢ ◫ ⌕ ▼ ✓ ✎ ⏸ ▶ ●`) — swap for an icon set (e.g. Lucide) if preferred, keeping 11–14px sizes. Fonts must be bundled locally for offline desktop use.

## Files
- `K8s Monitor.dc.html` — the full interactive prototype (open in a browser). Template = markup/styles; `class Component` = all behavior and mock data (pods, resources, log line pools, YAML generator, events).
