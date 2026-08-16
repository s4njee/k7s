#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT ?? "5199";
const URL = `http://localhost:${PORT}`;
const OUT = "wiki/public/screenshots";
const CDP_PORT = 9335;
const PROFILE = "/tmp/k7s-wiki-shots-profile";

const WIDTH = 1440;
const HEIGHT = 900;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const SHOTS = [
  {
    name: "01-pods-table",
    script: `nav("Pods"); closePanel();`,
  },
  {
    name: "02-logs",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(600); tab("Logs");`,
  },
  {
    name: "03-properties",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("Properties");`,
  },
  {
    name: "04-yaml",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("YAML");`,
  },
  {
    name: "05-shell",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("Shell");`,
  },
  {
    name: "06-metrics",
    script: `nav("Nodes"); await sleep(400); row(0); await sleep(500); tab("Metrics");`,
  },
  {
    name: "07-cluster-overview",
    script: `nav("Overview"); closePanel();`,
  },
  {
    name: "08-problems",
    script: `nav("Problems"); closePanel();`,
  },
  {
    name: "09-deployments",
    script: `nav("Deployments"); closePanel();`,
  },
  {
    name: "10-helm-releases",
    script: `nav("Releases"); closePanel(); await sleep(300); row(0); await sleep(500);`,
  },
  {
    name: "11-port-forwards",
    script: `
      closePanel();
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Forward") || b.title?.includes("Forward"));
      if (btn) btn.click();
      else { nav("Pods"); await sleep(300); row(0); }
    `,
  },
  {
    name: "12-command-palette",
    script: `
      closePanel();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      await sleep(400);
    `,
  },
  {
    name: "13-kubectl-terminal",
    script: `
      closePanel();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", metaKey: true, bubbles: true }));
      await sleep(500);
    `,
  },
  {
    name: "14-events-tab",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("Events");`,
  },
  {
    name: "15-topology-tab",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("Topology");`,
  },
  {
    name: "16-diff-tab",
    script: `nav("Pods"); await sleep(300); row(5); await sleep(500); tab("Diff");`,
  },
  {
    name: "17-settings-panel",
    script: `
      closePanel();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
      await sleep(400);
    `,
  }
];

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

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome never exposed a debugging target");
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression: `(async () => { ${HELPERS}\n${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    console.warn("Script warning:", exceptionDetails.exception?.description);
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // Force prefers-color-scheme: light
  await send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });

  await send("Page.navigate", { url: URL });
  await sleep(1500);

  // Set light theme in storage and reload
  await evaluate(`
    localStorage.setItem("k7s.theme", "light");
    document.documentElement.setAttribute("data-theme", "light");
  `);
  await send("Page.reload");
  await sleep(2500);

  // Ensure light mode is applied
  await evaluate(`
    document.documentElement.setAttribute("data-theme", "light");
  `);
  await sleep(500);

  for (const shot of SHOTS) {
    try {
      await evaluate(shot.script);
      await sleep(1000);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const file = `${OUT}/${shot.name}.png`;
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`  ✓ Saved light-mode ${file}`);
    } catch (err) {
      console.error(`  ✗ Error capturing ${shot.name}:`, err.message);
    }
  }

  ws.close();
  chrome.kill();
  await sleep(500);
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
  console.log(`Finished writing light mode screenshots to ${OUT}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
