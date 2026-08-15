#!/usr/bin/env node
/**
 * Manifested live-harness runner (B83).
 *
 * Runs the k7s Rust live verification harnesses (src-tauri/examples/*_check.rs)
 * against a live cluster and records pass / skip / fail. The example binaries
 * are built once with `cargo build --examples`; this script iterates the
 * inventory in src-tauri/examples/manifest.json, pre-skips any harness whose
 * fixtures aren't provisioned, and classifies each run from its exit code and
 * the HARNESS_SKIP: marker printed by k7s_lib::harness::skip.
 *
 *   cargo build --examples
 *   ./dev/cluster/up.sh --metrics && ./dev/cluster/helm-fixture.sh
 *   node dev/run-harnesses.mjs --fixtures kind,helm,metrics,multi --json harness-results.json
 *
 * Exit 1 if any harness fails — the CI gate. Cleanup is enforced by killing
 * timed-out children; kind teardown belongs to the caller (CI tears it down in
 * an always() step).
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MANIFEST = join(ROOT, "src-tauri", "examples", "manifest.json");

const SKIP_MARKER = "HARNESS_SKIP:";
/** Regex that also catches skip sites not yet converted to the marker. */
const UNMARKED_SKIP = /\bskipping\b|\bskip\b/i;

function usage() {
  console.error(
    "usage: run-harnesses.mjs [--bin-dir <dir>] [--fixtures a,b,c] [--json <out>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    binDir: join(ROOT, "src-tauri", "target", "debug", "examples"),
    fixtures: new Set(["kind"]),
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bin-dir") args.binDir = resolve(ROOT, argv[++i]);
    else if (a === "--fixtures") args.fixtures = new Set(argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--json") args.json = argv[++i];
    else usage();
  }
  return args;
}

/** Wait for a child, killing it at the deadline. Resolves the exit status. */
function run(name, bin, timeoutS) {
  return new Promise((resolveRun) => {
    const child = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutS * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveRun({ status: "fail", note: `could not spawn: ${e.message}`, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = stdout + stderr;
      let status;
      let note;
      if (timedOut) {
        status = "fail";
        note = `timed out after ${timeoutS}s`;
      } else if (code !== 0) {
        status = "fail";
        note = `exited ${code}`;
      } else if (output.includes(SKIP_MARKER)) {
        status = "skip";
        note = (output.match(/HARNESS_SKIP:\s*([^\n]*)/)?.[1] ?? "").trim();
      } else {
        status = "pass";
        // A skip site we haven't converted would still exit 0 — surface it.
        if (UNMARKED_SKIP.test(output)) {
          note = "warn: output mentions skipping but no HARNESS_SKIP marker";
        }
      }
      resolveRun({ status, note, stdout, stderr });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

  console.log(`fixtures: ${[...args.fixtures].join(", ")}`);
  console.log(`bin-dir : ${args.binDir}`);
  console.log(`harnesses: ${manifest.harnesses.length}\n`);

  const results = [];
  let failures = 0;

  for (const h of manifest.harnesses) {
    const missing = h.requires.filter((f) => !args.fixtures.has(f));
    if (missing.length > 0) {
      results.push({ name: h.name, status: "skip", duration_s: 0, note: `fixture not provisioned: ${missing.join(", ")}` });
      console.log(`  SKIP   ${h.name.padEnd(24)} (needs ${missing.join(", ")})`);
      continue;
    }

    const start = Date.now();
    const r = await run(h.name, join(args.binDir, h.name), h.timeout_s);
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    results.push({ name: h.name, status: r.status, duration_s: Number(duration), note: r.note });

    const line = `  ${r.status.toUpperCase().padEnd(6)} ${h.name.padEnd(24)} ${duration}s`;
    if (r.status === "fail") {
      failures++;
      console.error(line);
      // Publish the failure's tail so a CI log is immediately diagnosable.
      const tail = (r.stdout + r.stderr).split("\n").slice(-25).join("\n");
      console.error(tail);
    } else {
      console.log(line);
    }
  }

  const summary = { date: new Date().toISOString(), fixtures: [...args.fixtures], results };
  const byStatus = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`\nsummary: ${JSON.stringify(byStatus)}`);

  if (args.json) writeFileSync(resolve(ROOT, args.json), JSON.stringify(summary, null, 2));
  if (failures > 0) {
    console.error(`\n${failures} harness(es) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
