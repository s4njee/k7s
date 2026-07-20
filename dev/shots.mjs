#!/usr/bin/env node
/**
 * Regenerate the README screenshots.
 *
 *   pnpm dev:shots           # assumes a demo server on :5199
 *   PORT=5199 node dev/shots.mjs
 *
 * Drives headless Chrome over the DevTools Protocol using Node's built-in
 * WebSocket (Node 22+), so this adds no dependency and never touches your real
 * Chrome profile — it runs against a throwaway user-data-dir.
 *
 * Why not just capture the app window? Because these shots need *state*: a
 * specific pod selected, a specific tab open. A one-shot `--screenshot` can't do
 * that, and hand-driving the real UI makes the images un-reproducible — they'd
 * drift from the app the first time a panel changed and nobody would notice.
 *
 * Shots are taken against demo mode (VITE_DEMO=1) deliberately: the fixture data
 * is stable and contains the interesting states (a CrashLoopBackOff pod, a
 * not-found Secret reference), and no real cluster's names end up in the repo.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT ?? "5199";
const URL = `http://localhost:${PORT}`;
const OUT = "docs/screenshots";
const CDP_PORT = 9333;
const PROFILE = "/tmp/k7s-shots-profile";

// 2x then downscale: a 1x capture looks soft on the retina displays these are
// mostly read on, and a raw 2x file is needlessly heavy in git.
const WIDTH = 1440;
const HEIGHT = 900;

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The six shots: a label, and the page script that puts the UI in that state. */
const SHOTS = [
  {
    name: "01-pods-table",
    caption: "the resource table",
    script: `nav("Pods"); closePanel();`,
  },
  {
    name: "02-logs",
    caption: "logs",
    // Row 5 is the CrashLoopBackOff pod — the one with WARN/ERROR lines worth showing.
    script: `nav("Pods"); await sleep(300); row(5); await sleep(600); tab("Logs");`,
  },
  {
    name: "03-properties",
    caption: "properties",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("Properties");`,
  },
  {
    name: "04-yaml",
    caption: "YAML",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("YAML");`,
  },
  {
    name: "05-shell",
    caption: "shell",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("Shell");`,
  },
  {
    name: "06-metrics",
    caption: "node metrics",
    script: `nav("Nodes"); await sleep(400); row(0); await sleep(500); tab("Metrics");`,
  },
];

/** Helpers injected into the page; the app has no routing, so state is set by clicking. */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const leaf = (text) =>
    [...document.querySelectorAll("*")].find(
      (n) => n.children.length === 0 && n.textContent.trim() === text,
    );
  const nav = (label) => leaf(label)?.click();
  const tab = (label) => leaf(label)?.click();
  const row = (i) =>
    document.querySelectorAll("tbody tr")[i]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  const closePanel = () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
`;

// ---- minimal CDP client ----

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function connect() {
  // Chrome needs a moment to open the debugging port.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("Chrome never exposed a debugging target");
}

/** Run an async expression in the page and wait for it. */
async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression: `(async () => { ${HELPERS}\n${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? "page script failed");
  }
  return result?.value;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    URL,
  ]);
  chrome.on("error", (e) => {
    console.error("failed to launch Chrome:", e.message);
    process.exit(1);
  });

  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  await send("Page.enable");
  await send("Runtime.enable");
  // 2x for crisp text; downscaled after capture.
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // The theme is read from localStorage before first paint, so set it and reload.
  await send("Page.navigate", { url: URL });
  await sleep(1500);
  await evaluate(`localStorage.setItem("k7s.theme", "light");`);
  await send("Page.reload");
  await sleep(2500);

  for (const shot of SHOTS) {
    await evaluate(shot.script);
    // Let charts draw and the log ticker settle.
    await sleep(1200);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const file = `${OUT}/${shot.name}.png`;
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`  ${file}`);
  }

  ws.close();
  chrome.kill();
  // Chrome flushes its profile asynchronously, so an immediate rm races it and
  // throws ENOTEMPTY *after* every screenshot has already been written — which
  // would look like a failed run. Give it a moment, and never let cleanup fail
  // the script.
  await sleep(500);
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* a leftover temp profile is harmless */
  }
  console.log(`\n${SHOTS.length} screenshots written to ${OUT}/`);
  console.log(`Downscale to ${WIDTH}px wide with:`);
  console.log(`  sips --resampleWidth ${WIDTH} ${OUT}/*.png >/dev/null`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
