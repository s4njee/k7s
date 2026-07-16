#!/usr/bin/env bash
#
# dev/run.sh — start exactly one k7s dev stack, and fail loudly rather than
# silently lying about what's on screen (B24).
#
# The failure this exists to prevent: `tauri dev` serves the webview from
# `devUrl` (http://localhost:1420), but `tauri.conf.json` also declares
# `frontendDist: "../dist"`. If a stale `dist/` is lying around and vite isn't
# actually up on 1420 — because a previous run left an orphan holding the port,
# or vite died — the window can come up showing a *bundled build from whenever
# `npm run build` last ran*. It looks like the app, but with features missing.
# We lost real time to this twice: it reads as "the code didn't work" when in
# fact the code was never loaded.
#
# So this script:
#   1. kills prior k7s dev processes — matched by this repo's path, never by
#      bare names like "vite" (you may well have another project's dev server
#      running; killing it would be an unforgivable way to fix our own mess)
#   2. refuses to continue if something *else* owns port 1420, rather than
#      killing a stranger's process
#   3. deletes `dist/`, so a fallback to a stale bundle is impossible rather
#      than merely unlikely
#   4. launches one `npm run tauri:dev`, and shouts if vite never appears or
#      dies underneath it
#
# Usage:  dev/run.sh              # against your current kubeconfig context
#         KUBECONFIG=… dev/run.sh # against a specific one

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=1420
# How long the Rust build may take before we assume vite is never coming.
STARTUP_TIMEOUT=180

cd "$REPO"

# --- pretty output ------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; DIM=""; OFF=""
fi
info() { echo "${DIM}dev:${OFF} $*"; }
ok()   { echo "${GREEN}dev:${OFF} $*"; }
die()  { echo "${RED}${BOLD}dev: $*${OFF}" >&2; exit 1; }

# --- 1. kill prior k7s dev processes -----------------------------------------

# A process's working directory, used to prove a process is *ours*.
proc_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

# Every k7s dev process, whoever started it.
#
# Matching this precisely is the entire job, and it's fiddlier than it looks —
# the obvious spellings are all wrong in a way that fails *silently*, leaving the
# orphan that causes the stale window:
#
#   - `pkill -f vite` would kill other projects' dev servers. Never match bare
#     tool names.
#   - The node-hosted tools carry this repo's absolute path, so they can be
#     matched on it — but only anchored to the start of the command line.
#     Unanchored, the pattern also matches any shell that merely *mentions* the
#     path (a grep, an editor, this script's own caller), and we'd kill those.
#   - The app binary can't be matched by path at all: cargo launches it from
#     src-tauri as the *relative* `target/debug/k7s`. An absolute pattern finds
#     nothing and reports success. It's identified by exact process name instead,
#     with the working directory proving it's this repo's and not some other
#     project's binary that happens to share a name.
#
# The `npm run tauri:dev` wrapper is deliberately absent: it exits by itself once
# the CLI beneath it dies, and its command line has nothing tying it to this repo.
k7s_dev_pids() {
  {
    pgrep -f "^[^ ]*node .*$REPO/node_modules/.*(vite/bin/vite\.js|tauri\.js dev)" || true
    pgrep -f "^$REPO/node_modules/.*esbuild.*--service" || true
    local pid
    for pid in $(pgrep -x k7s || true); do
      case "$(proc_cwd "$pid")" in "$REPO"*) echo "$pid" ;; esac
    done
  } | sort -un | grep -vx "$$" || true
}

# Stop the whole stack. Safe to call repeatedly; used before launching and on the
# way out.
#
# By pattern rather than by walking the process tree, because the tree is
# `npm` → `tauri.js dev` → `cargo` → `k7s`, and signalling the top leaves both
# vite and the app running. That orphan is the bug this script exists to prevent,
# so it must not survive our own exit either.
stop_k7s_dev() {
  local announce="${1:-quiet}" pid killed=0
  for pid in $(k7s_dev_pids); do
    if kill -TERM "$pid" 2>/dev/null; then
      [[ "$announce" == "announce" ]] && info "stopped stale process $pid"
      killed=$((killed + 1))
    fi
  done

  (( killed == 0 )) && return 0

  # Give them a moment to release the port and their file locks.
  sleep 2
  # Anything that ignored SIGTERM gets SIGKILL — an orphan holding 1420 is the
  # whole reason we're here.
  for pid in $(k7s_dev_pids); do
    if kill -KILL "$pid" 2>/dev/null; then
      [[ "$announce" == "announce" ]] && info "force-stopped $pid"
    fi
  done
  return 0
}

stop_k7s_dev announce

# --- 2. the port must be ours, or free ---------------------------------------
holder="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$holder" ]]; then
  owner_cmd="$(ps -o command= -p "$holder" 2>/dev/null || echo "?")"
  if [[ "$owner_cmd" == *"$REPO"* ]]; then
    kill -KILL "$holder" 2>/dev/null || true
    info "freed port $PORT (was held by our own $holder)"
    sleep 1
  else
    # Not ours. Say whose it is and stop — vite has strictPort, so it would fail
    # anyway, and killing someone else's server to make room is not our call.
    die "port $PORT is held by a process that isn't k7s (pid $holder):
    $owner_cmd
  Stop it yourself, or change server.port in vite.config.ts and devUrl in
  src-tauri/tauri.conf.json."
  fi
fi

# --- 3. no stale bundle to fall back to --------------------------------------
# `npm run build` (and `tauri build`) leave dist/ behind. In dev it's dead
# weight at best and a silent liar at worst, so it doesn't get to exist.
if [[ -d "$REPO/dist" ]]; then
  rm -rf "$REPO/dist"
  info "removed stale dist/ (a dev window must never render a bundled build)"
fi

# --- 4. launch exactly one stack ---------------------------------------------
port_open() { lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# Why the stack stopped, if we worked it out. A file because the watchdog runs in
# a subshell and can't hand a variable back.
REASON_FILE="$(mktemp -t k7s-dev-reason)"
QUIT_REQUESTED=0

ok "starting tauri dev${KUBECONFIG:+ with KUBECONFIG=$KUBECONFIG}"
npm run tauri:dev &
DEV_PID=$!

cleanup() {
  trap - INT TERM EXIT
  # `kill` on a subshell job makes bash dump the job's entire source to the
  # terminal; a named function keeps that to one tidy line.
  [[ -n "${WATCHDOG_PID:-}" ]] && kill "$WATCHDOG_PID" 2>/dev/null || true
  kill -TERM "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  # Signalling npm is not enough: vite and the app survive it, keeping port 1420
  # and re-creating the exact orphan the next run has to clean up.
  stop_k7s_dev
  rm -f "$REASON_FILE"
}
on_quit() { QUIT_REQUESTED=1; cleanup; exit 0; }
trap on_quit INT TERM
trap cleanup EXIT

# Watchdog: vite being up is the difference between seeing your code and seeing a
# ghost, so it's checked rather than assumed. It records *why* it intervened,
# because the tauri CLI often notices vite's death first and exits — which would
# otherwise leave the app gone with no explanation at all.
watchdog() {
  local i
  for ((i = 0; i < STARTUP_TIMEOUT; i++)); do
    kill -0 "$DEV_PID" 2>/dev/null || return 0   # exited on its own; main reports
    port_open && break
    sleep 1
  done

  if ! port_open; then
    printf '%s' "vite never came up on port $PORT within ${STARTUP_TIMEOUT}s" > "$REASON_FILE"
    kill -TERM "$DEV_PID" 2>/dev/null || true
    return 1
  fi
  ok "vite is up on $PORT — the window is serving live code"

  # Vite dying mid-session is the nastiest version of this bug: the window stays
  # open, still showing whatever it last built.
  while kill -0 "$DEV_PID" 2>/dev/null; do
    if ! port_open; then
      printf '%s' "vite died on port $PORT" > "$REASON_FILE"
      kill -TERM "$DEV_PID" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
}
watchdog &
WATCHDOG_PID=$!

# `wait` must not abort the script under `set -e` — a non-zero exit here is
# information we want to report, not a reason to vanish.
set +e
wait "$DEV_PID"
DEV_STATUS=$?
set -e

# Diagnose before the EXIT trap tidies up. Losing the race to the tauri CLI (it
# exits the moment vite dies) must not cost the explanation.
reason="$(cat "$REASON_FILE" 2>/dev/null || true)"
if [[ -z "$reason" ]] && (( QUIT_REQUESTED == 0 )) && ! port_open; then
  reason="vite is not running"
fi

if (( QUIT_REQUESTED == 0 )) && [[ -n "$reason" ]]; then
  die "$reason — the dev stack has stopped.
  A window left open now would be showing a stale bundle, not your code.
  Check the vite output above; then run dev/run.sh again."
fi

exit "$DEV_STATUS"
