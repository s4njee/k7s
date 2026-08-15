#!/usr/bin/env bash
#
# dev/check-version.sh — the three version files must agree, and on a tag push
# the tag must too (B69).
#
# The version lives in package.json, src-tauri/Cargo.toml and
# src-tauri/tauri.conf.json, and was historically hand-synced — which is how it
# drifted. This script is the gate: it runs in CI on every push/PR (and before
# dev/bump.sh moves the version), and fails loudly on disagreement.
#
# CI tag check: when GITHUB_REF_TYPE=tag (a `v*` tag push), the tag's version
# must equal the files'. A tag of v0.6.0 pointing at a tree that says 0.5.0 is
# a release nobody intended.
#
# Usage:  dev/check-version.sh           # exit 0 on consistency, 1 otherwise

set -euo pipefail
cd "$(dirname "$0")/.."

pkg=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)
cargo=$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' src-tauri/Cargo.toml | head -1)
tauri=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)

if [[ -z "$pkg" || -z "$cargo" || -z "$tauri" ]]; then
  echo "could not read a version — are the files where this script expects?" >&2
  echo "  package.json            -> '$pkg'" >&2
  echo "  src-tauri/Cargo.toml    -> '$cargo'" >&2
  echo "  src-tauri/tauri.conf.json -> '$tauri'" >&2
  exit 1
fi

if [[ "$pkg" != "$cargo" || "$cargo" != "$tauri" ]]; then
  echo "version mismatch across the three version files:" >&2
  echo "  package.json              = $pkg" >&2
  echo "  src-tauri/Cargo.toml      = $cargo" >&2
  echo "  src-tauri/tauri.conf.json = $tauri" >&2
  echo "fix with: dev/bump.sh <version>" >&2
  exit 1
fi

echo "versions agree: $pkg"

# On a tag push, the tag name is the source of truth for the release version.
if [[ "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
  tag="${GITHUB_REF_NAME#v}"
  if [[ "$tag" != "$pkg" ]]; then
    echo "tag v$tag disagrees with the tree's version $pkg" >&2
    exit 1
  fi
  echo "tag matches: v$tag"
fi
