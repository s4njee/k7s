/**
 * Tests for MockProvider's PodPoint history (B44). Demo mode has no Prometheus,
 * so the mock synthesises a plausible half-hour walk ending near the pod's
 * current mock usage — the newest point should read like what the live Metrics
 * tab shows now.
 */

import { describe, expect, it } from "vitest";
import { MockProvider } from "./MockProvider";

const P = () => new MockProvider();

describe("MockProvider.podHistory (B44)", () => {
  it("synthesises an ascending, current-valued history for a real demo pod", async () => {
    const history = await P().podHistory("prod", "valkyrie-api-7d9f8b64d-x2k4n");
    expect(history.length).toBe(60);

    // Timestamps ascend toward now, one 30s step apart.
    for (let i = 1; i < history.length; i++) {
      expect(history[i].ts - history[i - 1].ts).toBe(30_000);
    }
    expect(history[history.length - 1].ts).toBeLessThanOrEqual(Date.now());

    // Values stay positive throughout.
    for (const pt of history) {
      expect(pt.cpuMillis).toBeGreaterThan(0);
      expect(pt.memBytes).toBeGreaterThan(0);
    }

    // The newest point lands near the pod's mock usage (212m / 486Mi) — the
    // walk's target rises to current, so only noise keeps it from being exact.
    const last = history[history.length - 1];
    expect(last.cpuMillis).toBeGreaterThan(150);
    expect(last.cpuMillis).toBeLessThan(280);
    expect(last.memBytes).toBeGreaterThan(300 * 1024 ** 2);
    expect(last.memBytes).toBeLessThan(600 * 1024 ** 2);
  });

  it("returns no history for a pod demo data has no usage for", async () => {
    expect(await P().podHistory("prod", "does-not-exist")).toEqual([]);
  });
});
