#!/usr/bin/env node
/**
 * Packaged-app e2e orchestrator (B83): starts the tauri-driver WebDriver server,
 * waits for it, runs the golden-path script against it, and cleans up.
 *
 *   ./dev/cluster/up.sh --metrics && ./dev/cluster/helm-fixture.sh
 *   pnpm build
 *   TAURI_CONFIG="$(cat dev/tauri.e2e.conf.json)" cargo build --release --manifest-path src-tauri/Cargo.toml
 *   xvfb-run -a node dev/e2e.mjs            # needs `tauri-driver` on PATH (Linux/Windows)
 *
 * tauri-driver is installed in CI via `cargo install tauri-driver`; locally:
 * `cargo install tauri-driver` (Linux) — the packaged e2e is a Linux path.
 */

import { spawn } from "node:child_process";
import { net } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DRIVER_PORT = Number(process.env.TAURI_DRIVER_PORT ?? "4444");

const args = process.argv.slice(2);
const app = resolve(args.find((a, i) => args[i - 1] === "--app") ?? resolve(ROOT, "src-tauri/target/release/k7s"));
const skipOutage = args.includes("--skip-outage");

if (!existsSync(app)) {
  console.error(`app binary not found: ${app}\n  pnpm build && TAURI_CONFIG="$(cat dev/tauri.e2e.conf.json)" cargo build --release --manifest-path src-tauri/Cargo.toml`);
  process.exit(2);
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveOk, reject) => {
    const probe = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.end();
        resolveOk();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`tauri-driver did not open port ${port}`));
        else setTimeout(probe, 250);
      });
    };
    probe();
  });
}

console.log(`app: ${app}`);
console.log(`starting tauri-driver on 127.0.0.1:${DRIVER_PORT}…`);

const driver = spawn("tauri-driver", [], {
  env: { ...process.env, TAURI_DRIVER_PORT: String(DRIVER_PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});

driver.once("error", (e) => {
  console.error(`cannot start tauri-driver: ${e.message}\n  Install it: cargo install tauri-driver`);
  process.exit(2);
});
driver.once("exit", (code) => {
  if (code !== 0 && !stopped) {
    console.error(`tauri-driver exited early (code ${code})`);
    process.exit(2);
  }
});

let stopped = false;
function stopDriver() {
  if (stopped) return;
  stopped = true;
  try {
    driver.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

try {
  await waitForPort(DRIVER_PORT, 60000);
  const scriptArgs = [`${ROOT}/e2e/golden-path.mjs`, "--app", app];
  if (skipOutage) scriptArgs.push("--skip-outage");
  const child = spawn("node", scriptArgs, { cwd: ROOT, stdio: "inherit", env: process.env });
  const code = await new Promise((r) => child.on("close", r));
  stopDriver();
  console.log(`\ne2e exited with code ${code}`);
  process.exit(code ?? 1);
} catch (e) {
  stopDriver();
  console.error(e);
  process.exit(1);
}
