#!/usr/bin/env node
/**
 * Assemble the Tauri updater manifest (latest.json) for a release (B72).
 *
 * `tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'` signs each
 * platform's update artifact and writes a `<artifact>.sig` next to it, but the
 * bundler does not emit the combined manifest — that is this script's job. It
 * scans the CI-collected `.sig` files, reads the signature for each platform,
 * and writes the static manifest whose per-platform `url` points at the
 * tag-pinned GitHub release download URL (tag-pinned so an older app version's
 * stored manifests keep resolving).
 *
 * The `notes` field is the CHANGELOG.md section for the version being released
 * (B72: "the update notice links the CHANGELOG section").
 *
 * Usage:
 *   node dev/updater-manifest.mjs \
 *     --version 0.5.0 --tag v0.5.0 --repo s4njee/k7s \
 *     --sig-dir updater \
 *     --map darwin-aarch64='k7s.app.tar.gz' \
 *     --map windows-x86_64='k7s-setup.exe' \
 *     --map linux-x86_64='k7s_*_amd64.AppImage' \
 *     -o latest.json
 *
 * `--map target=glob` — the glob (only `*` is special) matches the basename of a
 * `*.sig` file under `--sig-dir`; the matched artifact name becomes the URL
 * path. `--tag` is the release tag (e.g. v0.5.0); it defaults to `--version`.
 * `--notes` overrides the changelog lookup. Missing anything exits non-zero so
 * CI fails loudly rather than shipping a manifest that can't install.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { map: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--map") args.map.push(argv[++i]);
    else if (a.startsWith("--map=")) args.map.push(a.slice("--map=".length));
    else if (a === "-o") args.o = argv[++i];
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}

/** A `--map` glob has only `*` special; everything else is literal. */
function globToRegExp(glob) {
  const literal = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${literal}$`);
}

function findSigFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) findSigFiles(p, out);
    else if (entry.endsWith(".sig")) out.push(p);
  }
  return out;
}

/** The CHANGELOG.md section for `version`, or a fallback when absent. */
function changelogNotes(version, changelogPath) {
  try {
    const text = readFileSync(changelogPath, "utf8");
    const re = new RegExp(
      `## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`,
    );
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    // Fall through to the default note.
  }
  return `See the changelog for ${version}: https://github.com/s4njee/k7s/blob/main/CHANGELOG.md`;
}

const args = parseArgs(process.argv.slice(2));

const version = args.version;
if (!version) {
  console.error("missing --version (the app version being released)");
  process.exit(1);
}
const repo = args.repo ?? "s4njee/k7s";
const tag = args.tag ?? version;
const sigDir = args["sig-dir"];
if (!sigDir) {
  console.error("missing --sig-dir (directory of the CI-collected *.sig files)");
  process.exit(1);
}
if (args.map.length === 0) {
  console.error("missing --map target=glob (at least one platform)");
  process.exit(1);
}

const sigs = findSigFiles(sigDir); // full paths; matched on basename
const notes = args.notes ?? changelogNotes(version, args.changelog ?? "CHANGELOG.md");

const platforms = {};
for (const map of args.map) {
  const eq = map.indexOf("=");
  const target = map.slice(0, eq);
  const pattern = map.slice(eq + 1);
  const re = globToRegExp(`${pattern}.sig`);
  const sigPath = sigs.find((p) => re.test(p.split("/").pop()));
  if (!sigPath) {
    console.error(
      `no .sig under ${sigDir} matches '${pattern}.sig' for platform ${target}; ` +
        `found: ${sigs.length ? sigs.map((p) => p.split("/").pop()).join(", ") : "(none)"}`,
    );
    process.exit(1);
  }
  const artifact = sigPath.split("/").pop().replace(/\.sig$/, "");
  platforms[target] = {
    signature: readFileSync(sigPath, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${artifact}`,
  };
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

const out = args.o ?? "latest.json";
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${out}: version ${version}, platforms ${Object.keys(platforms).join(", ")}`);
