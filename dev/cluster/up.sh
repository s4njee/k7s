#!/usr/bin/env bash
#
# Bring up the k7s fixture cluster: a local `kind` cluster seeded with the
# manifests in ./manifests, plus (optionally) metrics-server so the CPU/MEM
# columns light up. Idempotent — safe to re-run.
#
# Requires: kind, kubectl. Install kind: https://kind.sigs.k8s.io/
set -euo pipefail

CLUSTER="k7s-dev"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Ensuring kind cluster '${CLUSTER}' exists"
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "    (already exists)"
else
  kind create cluster --config "${HERE}/kind-config.yaml"
fi

# Point kubectl at the fixture cluster for the rest of this script.
kubectl config use-context "kind-${CLUSTER}"

echo "==> Applying fixture manifests"
# Apply the prerequisites separately. A directory apply can submit the VPA
# object before the CRD is Established, and a newly-created namespace can be
# admitted before its controller has created the default service account.
kubectl apply -f "${HERE}/manifests/00-namespaces.yaml"
for namespace in prod staging monitoring; do
  kubectl wait --for=jsonpath='{.status.phase}'=Active \
    --timeout=60s "namespace/${namespace}"
  kubectl create serviceaccount default \
    --namespace "${namespace}" \
    --dry-run=client -o yaml | kubectl apply -f -
done

kubectl apply -f "${HERE}/manifests/55-crds.yaml"
kubectl wait --for=condition=Established \
  --timeout=60s "crd/verticalpodautoscalers.autoscaling.k8s.io"

kubectl apply -f "${HERE}/manifests/"

# metrics-server is optional; without it the app shows "—" for CPU/MEM, which is
# itself a supported state worth testing. Enable by passing --metrics.
if [[ "${1:-}" == "--metrics" ]]; then
  echo "==> Installing metrics-server (with --kubelet-insecure-tls for kind)"
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  # kind's kubelet serving certs aren't signed by the cluster CA; allow insecure.
  kubectl -n kube-system patch deployment metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi

echo
echo "==> Done. The fixture cluster is up as kubeconfig context 'kind-${CLUSTER}'."
echo "    Launch the app and pick that context (or run: npm run tauri:dev)."
