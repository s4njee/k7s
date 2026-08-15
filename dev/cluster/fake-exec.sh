#!/usr/bin/env bash
# Fake exec credential plugin for the B74-L exec-check harness
# (examples/exec_check.rs). kube invokes this per a kubeconfig `user.exec` block;
# its env (mode / token file / count file) comes from the block's `exec.env`.
#
#   success : a valid, non-expiring token from K7S_FAKE_EXEC_TOKEN_FILE
#   expired : the same token with a past expirationTimestamp, so kube re-execs
#             on the next request (observed via K7S_FAKE_EXEC_COUNT_FILE)
#   bad     : stdout that isn't an ExecCredential at all
#   nonzero : exits 1
#
# The only stdout is the ExecCredential JSON — kube parses stdout verbatim.
set -euo pipefail

if [[ -n "${K7S_FAKE_EXEC_COUNT_FILE:-}" ]]; then
  echo "$$" >> "$K7S_FAKE_EXEC_COUNT_FILE"
fi

token_file="${K7S_FAKE_EXEC_TOKEN_FILE:-}"
emit() { # $1 = expirationTimestamp (or empty)
  local ts="${1:-}"
  local token
  token="$(cat "$token_file")"
  if [[ -n "$ts" ]]; then
    printf '{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1","status":{"token":"%s","expirationTimestamp":"%s"}}\n' "$token" "$ts"
  else
    printf '{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1","status":{"token":"%s"}}\n' "$token"
  fi
}

case "${K7S_FAKE_EXEC_MODE:-success}" in
  bad) echo "this is not an ExecCredential" ;;
  nonzero) exit 1 ;;
  expired) emit "2000-01-01T00:00:00Z" ;;
  *) emit "" ;;
esac
