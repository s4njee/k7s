#!/usr/bin/env bash
#
# One-command local verification — the same gates CI runs, so a local check and a
# CI run cannot drift (backlog hygiene note). Optional live-harness run when a
# cluster is up.
#
#   ./dev/verify.sh                # typecheck + vitest + clippy + cargo test
#   ./dev/verify.sh --live         # ... plus the live-harness runner (B83)
#
# --live expects the fixture cluster and its extras already provisioned:
#   ./dev/cluster/up.sh --metrics && ./dev/cluster/helm-fixture.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

echo "==> typecheck"
pnpm run typecheck

echo "==> frontend tests"
pnpm test

echo "==> clippy (-D warnings)"
(cd src-tauri && cargo clippy --all-targets -- -D warnings)

echo "==> rust tests"
(cd src-tauri && cargo test)

if [[ "${1:-}" == "--live" ]]; then
  echo "==> building examples"
  (cd src-tauri && cargo build --examples)
  echo "==> live harnesses (fixtures: kind, helm, metrics, multi)"
  node dev/run-harnesses.mjs --fixtures kind,helm,metrics,multi --json harness-results.json
fi

echo "==> all green"
