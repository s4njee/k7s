/**
 * Packaged-app golden path (B83): drives the built k7s binary through the
 * WebDriver session tauri-driver serves, against the kind fixture cluster.
 *
 *   connect → overview → pod → logs → YAML dry run → safe mutation → recovery
 *   after a simulated outage.
 *
 * Run via dev/e2e.mjs (which starts tauri-driver), or directly once a driver is
 * on 127.0.0.1:4444:
 *
 *   node e2e/golden-path.mjs --app src-tauri/target/release/k7s [--skip-outage]
 *
 * Every step is recorded to e2e-results.json (the flake ledger for the nightly
 * job); a step that times out fails red. The outage step stops and starts the
 * kind control-plane container to simulate the API going away — the B74-L stale
 * badge must appear and then clear on recovery.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { remote } from "webdriverio";

const APP = resolve(process.argv.find((a, i) => process.argv[i - 1] === "--app") ?? "src-tauri/target/release/k7s");
const SKIP_OUTAGE = process.argv.includes("--skip-outage");
const DRIVER_PORT = Number(process.env.TAURI_DRIVER_PORT ?? "4444");

/** The kind cluster's control-plane container name (cluster name + -control-plane). */
const CLUSTER_CONTAINER = process.env.K7S_E2E_CLUSTER ?? "k7s-dev-control-plane";

const steps = [];

function record(name, fn) {
  const start = Date.now();
  return fn()
    .then(() => {
      steps.push({ name, status: "pass", duration_ms: Date.now() - start });
      console.log(`  PASS   ${name}`);
    })
    .catch((e) => {
      steps.push({ name, status: "fail", duration_ms: Date.now() - start, error: String(e?.message ?? e) });
      console.error(`  FAIL   ${name}: ${e?.message ?? e}`);
      throw e;
    });
}

/** Find an element by (sub)text; waits for it to exist. */
async function byText(text, { timeout = 15000, exact = false } = {}) {
  const xp = exact ? `//*[text()=${JSON.stringify(text)}]` : `//*[contains(text(), ${JSON.stringify(text)})]`;
  const el = await browser.$(xp);
  await el.waitForExist({ timeout });
  return el;
}

async function main() {
  console.log(`app: ${APP}`);
  console.log(`driver: 127.0.0.1:${DRIVER_PORT}`);
  console.log("connecting to tauri-driver…");

  const browser = await remote({
    hostname: "127.0.0.1",
    port: DRIVER_PORT,
    logLevel: "error",
    capabilities: {
      browserName: "wry",
      "tauri:options": { application: APP },
    },
  });

  try {
    // ---- connect (the app auto-connects the kubeconfig's current context) ----
    await record("connect", async () => {
      // App boot under xvfb is slow; give the first paint a long leash.
      const el = await byText("kind-k7s-dev", { timeout: 45000 });
      await el.waitForDisplayed({ timeout: 10000 });
    });

    // ---- overview ----
    await record("overview", async () => {
      // Status bar proves a live, single-node cluster.
      await byText("nodes 1/1 ready", { timeout: 15000 });
    });

    // ---- pod: nav to Pods, open a pod's detail ----
    let selectedPod = "";
    await record("pod", async () => {
      await (await byText("Pods")).click();
      // A fixture pod row (CrashLoopBackOff is the interesting one).
      const row = await byText("heimdall-auth-6b8c9d5f7-qq3rt", { timeout: 20000 });
      selectedPod = await row.getText();
      await row.click();
      // Detail panel header shows the selected pod.
      await byText(selectedPod.slice(0, 20), { timeout: 10000 });
    });

    // ---- logs: the pod's Logs tab streams ----
    await record("logs", async () => {
      // Pods open on Logs; the fixture pods log INFO lines. Busybox logs can be
      // sparse, so wait for any log content.
      await byText("INFO", { timeout: 25000 });
    });

    // ---- YAML dry run: edit → preview → review ----
    await record("yaml-dry-run", async () => {
      await (await byText("YAML")).click();
      await (await byText("✎ Edit", { timeout: 15000 })).click();
      // Type into the CodeMirror editor (a contenteditable), then preview.
      const editor = await browser.$('//*[contains(@class,"cm-content")]');
      await editor.click();
      await browser.keys(["End", "Enter", "  labels:", "Enter", "    k7s.e2e: \"true\"", "Enter"]);
      await (await byText("Preview changes")).click();
      // Review mode is only reachable from the server's dry-run answer.
      await byText("Apply for real", { timeout: 15000 });
      await (await byText("Back to editing")).click();
    });

    // ---- safe mutation: rollout-restart a Deployment through the confirm dialog ----
    await record("safe-mutation", async () => {
      await (await byText("Deployments")).click();
      await (await byText("valkyrie-api", { timeout: 20000 })).click();
      // The detail panel's actions menu (⋯) → Restart… → confirm.
      await (await browser.$('//*[@title="actions"]')).click();
      await (await byText("Restart…")).click();
      const confirm = await byText("Restart", { exact: true });
      await confirm.click();
      // The dialog is gone once the mutation was confirmed.
      await confirm.waitForExist({ timeout: 10000, reverse: true });
    });

    // ---- recovery after a simulated outage (B74-L) ----
    if (!SKIP_OUTAGE) {
      await record("outage-recovery", async () => {
        execFileSync("docker", ["stop", CLUSTER_CONTAINER], { stdio: "pipe" });
        try {
          const stale = await byText("stale · retry", { timeout: 60000 });
          await stale.waitForDisplayed({ timeout: 10000 });
        } finally {
          // Bring the API back no matter how the assertion above went.
          execFileSync("docker", ["start", CLUSTER_CONTAINER], { stdio: "pipe" });
        }
        // Staleness clears automatically once the probe succeeds again.
        const stale = await byText("stale · retry", { timeout: 3000 }).catch(() => null);
        if (stale) await stale.waitForExist({ timeout: 120000, reverse: true });
        await byText("nodes 1/1 ready", { timeout: 120000 });
      });
    } else {
      console.log("  SKIP   outage-recovery (--skip-outage)");
    }

    console.log(`\ngolden path OK (${steps.filter((s) => s.status === "pass").length}/${steps.length} steps)`);
  } catch (e) {
    // Re-throw after recording; the JSON ledger always lands.
    console.error(`\ngolden path FAILED: ${e?.message ?? e}`);
    process.exitCode = 1;
  } finally {
    writeFileSync("e2e-results.json", JSON.stringify({ date: new Date().toISOString(), steps }, null, 2));
    try {
      await browser.deleteSession();
    } catch {
      /* the app may already be gone */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
