#!/usr/bin/env bash
#
# dev/bump.sh — set the version in the three files that carry it and stamp the
# changelog, so a release is: bump → commit → tag → push (B69).
#
#   dev/bump.sh 0.6.0
#
# What it does:
#   1. refuses a non-X.Y.Z argument, and refuses to run while the tree's three
#      version files already disagree — compounding a drift is how drift wins
#   2. sets package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json
#      to the new version
#   3. stamps CHANGELOG.md: the [Unreleased] block becomes a dated
#      `## [X.Y.Z] - YYYY-MM-DD` section, and a fresh [Unreleased] header is
#      left on top for the next cycle.
#
# Versioning policy (from CHANGELOG.md): 0.x minor per release-map row, 0.x.y
# patch for fixes. After running this, review the diff, commit, `git tag
# v<version>`, and push — CI then refuses a tag whose three versions disagree.
#
# Re-running for a version that is already in the changelog is a no-op on the
# section (never a duplicate) but still ensures the files are set, so the
# acceptance "bump.sh 0.5.0 leaves one consistent version" holds from any tree.

set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  echo "usage: dev/bump.sh <version>    e.g. dev/bump.sh 0.6.0" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage
new="$1"
[[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a version like X.Y.Z: $new" >&2; usage; }

# Guard: never move a version that is already out of sync.
./dev/check-version.sh

today=$(date +%F)

# ---- set the version in the three files --------------------------------------

# JSON: "version": "X.Y.Z" (package.json, tauri.conf.json). The Cargo.toml
# version is anchored at the start of the line, so dependency `version` keys are
# never touched.
sed -i.bak -E \
  -e "s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]+(\")/\1$new\2/" \
  package.json src-tauri/tauri.conf.json
sed -i.bak -E \
  -e "s/^(version[[:space:]]*=[[:space:]]*\")[^\"]+(\")/\1$new\2/" \
  src-tauri/Cargo.toml
rm -f package.json.bak src-tauri/tauri.conf.json.bak src-tauri/Cargo.toml.bak

# Cargo.lock carries the root package's version too; a full offline resolve
# rewrites that entry so the committed tree has no stale lock. Skipped cleanly
# when cargo is absent or the index isn't cached — the next `cargo build` syncs
# it anyway, and CI's `cargo test`/`clippy` never run with `--locked`.
if command -v cargo >/dev/null 2>&1; then
  (cd src-tauri && cargo metadata --offline >/dev/null 2>&1) || true
fi

# ---- stamp the changelog ------------------------------------------------------

if grep -q "^## \[$new\]" CHANGELOG.md; then
  echo "## [$new] already in CHANGELOG.md — section left as-is (files set to $new)."
  if [ -n "$(awk '/^## \[Unreleased\]/ { f=1; next } f && /^## \[/ { exit } f && NF { print }' CHANGELOG.md)" ]; then
    echo "note: [Unreleased] still has entries that were not stamped into [$new]; fold them in by hand if they belong to this release." >&2
  fi
else
  # Hand the [Unreleased] body to the rewrite through a temp file, never a `-v`
  # variable: macOS's awk rejects a newline inside a -v assignment value.
  body_file="$(mktemp "${TMPDIR:-/tmp}/k7s-bump-body.XXXXXX")"
  tmp_changelog="$(mktemp "${TMPDIR:-/tmp}/k7s-changelog.XXXXXX")"
  trap 'rm -f "$body_file" "$tmp_changelog"' EXIT

  # Capture the [Unreleased] body (its ### subsections and bullets), then strip
  # trailing blank lines so the stamped section ends cleanly before the next one.
  awk '
    /^## \[Unreleased\]/ { inblock = 1; next }
    inblock && /^## \[/ { exit }
    inblock { print }
  ' CHANGELOG.md | sed -e :a -e '/^$/N;/^\n$/D' -e ta > "$body_file"

  # Rewrite: emit a fresh [Unreleased] header, then the stamped `## [ver] - date`
  # section holding the captured body, then everything after the old block.
  awk -v ver="$new" -v date="$today" -v body_file="$body_file" '
    BEGIN { n = 0; while ((getline line < body_file) > 0) lines[++n] = line }
    /^## \[Unreleased\]/ {
      print "## [Unreleased]"
      print ""
      print "## [" ver "] - " date
      print ""
      if (n > 0) {
        for (i = 1; i <= n; i++) print lines[i]
        print ""
      }
      inblock = 1
      next
    }
    inblock {
      if ($0 ~ /^## \[/) inblock = 0
      else next
    }
    { print }
  ' CHANGELOG.md > "$tmp_changelog"
  mv "$tmp_changelog" CHANGELOG.md
  trap - EXIT
fi

# ---- confirm ----------------------------------------------------------------

./dev/check-version.sh
echo "bumped to $new — review the changelog diff, then commit, tag v$new, push."
