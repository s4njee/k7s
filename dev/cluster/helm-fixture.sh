#!/usr/bin/env bash
#
# Install the fixture Helm chart (B81) so there's a real release with two
# revisions to roll back / uninstall: rev 1 is color=red, rev 2 is color=blue.
#
# Deterministic: uninstalls any prior fixture-app first, so the revision numbers
# start at 1 every time. Run after ./dev/cluster/up.sh.
#
# Requires: helm (any v3+; the storage format is the same).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART="${HERE}/charts/fixture-app"
NS="prod"

echo "==> Resetting fixture-app (removing any previous copy)"
kubectl config use-context kind-k7s-dev >/dev/null
helm uninstall fixture-app -n "${NS}" --ignore-not-found >/dev/null 2>&1 || true

echo "==> Installing fixture-app rev 1 (color=red)"
helm install fixture-app "${CHART}" -n "${NS}" --set color=red --wait >/dev/null
echo "==> Upgrading to rev 2 (color=blue)"
helm upgrade fixture-app "${CHART}" -n "${NS}" --set color=blue --wait >/dev/null

echo
echo "==> Done. fixture-app is at revision 2 (color=blue); revision 1 was color=red."
echo "    helm history -n ${NS} fixture-app"
helm history -n "${NS}" fixture-app
