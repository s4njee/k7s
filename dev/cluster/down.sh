#!/usr/bin/env bash
#
# Tear down the k7s fixture cluster.
set -euo pipefail

CLUSTER="k7s-dev"

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "==> Deleting kind cluster '${CLUSTER}'"
  kind delete cluster --name "${CLUSTER}"
else
  echo "==> Cluster '${CLUSTER}' not found; nothing to do."
fi
