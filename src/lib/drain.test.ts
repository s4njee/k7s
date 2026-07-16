/**
 * Tests for how a drain reads in the UI (B20), and for the mock drain's progress
 * contract.
 *
 * The tone rule is the part worth pinning: a PDB block must not read as an error,
 * and a real error must not be masked by one.
 */

import { describe, expect, it } from "vitest";
import { drainErrors, drainSummary, drainTone, pdbBlocked } from "./drain";
import { MockProvider } from "../providers/mock/MockProvider";
import type { DrainProgress } from "../providers/types";

const base: DrainProgress = { node: "freya-node-02", evicted: 0, total: 6, failures: [], done: false };

const pdbFailure = {
  pod: "prod/yggdrasil-db-0",
  message: "blocked by a PodDisruptionBudget: …",
  blockedByPdb: true,
};
const realFailure = { pod: "prod/api-1", message: "pods \"api-1\" not found", blockedByPdb: false };

describe("drainTone", () => {
  it("reads neutral while working", () => {
    expect(drainTone({ ...base, evicted: 3 })).toBe("secondary");
  });

  it("reads ok once finished cleanly", () => {
    expect(drainTone({ ...base, evicted: 6, done: true })).toBe("ok");
  });

  it("reads warn — not err — when only a PDB held pods back", () => {
    // The cluster protecting a workload's declared availability is the system
    // working, not a failure.
    const p = { ...base, evicted: 5, failures: [pdbFailure], done: true };
    expect(drainTone(p)).toBe("warn");
  });

  it("reads err for a genuine failure", () => {
    expect(drainTone({ ...base, failures: [realFailure], done: true })).toBe("err");
  });

  it("lets a real error outrank a PDB block", () => {
    // Both happened: the error is the one that needs looking at.
    const p = { ...base, failures: [pdbFailure, realFailure], done: true };
    expect(drainTone(p)).toBe("err");
  });
});

describe("drainSummary", () => {
  it("distinguishes in-progress from finished", () => {
    expect(drainSummary({ ...base, evicted: 3 })).toBe("draining: 3/6 evicted");
    expect(drainSummary({ ...base, evicted: 6, done: true })).toBe("drain finished: 6/6 evicted");
  });
});

describe("failure partitioning", () => {
  it("splits PDB blocks from real errors", () => {
    const p = { ...base, failures: [pdbFailure, realFailure] };
    expect(pdbBlocked(p).map((f) => f.pod)).toEqual(["prod/yggdrasil-db-0"]);
    expect(drainErrors(p).map((f) => f.pod)).toEqual(["prod/api-1"]);
  });
});

describe("MockProvider.drainNode", () => {
  it("reports progress and finishes on a PDB block", async () => {
    const provider = new MockProvider();
    const seen: DrainProgress[] = [];
    provider.onDrainProgress((p) => seen.push(p));

    await provider.drainNode("freya-node-02");
    // The mock ticks over a couple of seconds; wait for the terminal event.
    await new Promise<void>((resolve) => {
      const check = () => (seen.at(-1)?.done ? resolve() : setTimeout(check, 50));
      check();
    });

    const last = seen.at(-1)!;
    expect(last.node).toBe("freya-node-02");
    expect(last.done).toBe(true);
    // Progress is monotonic — a banner that went backwards would be alarming.
    const evictions = seen.map((p) => p.evicted);
    expect(evictions).toEqual([...evictions].sort((a, b) => a - b));
    // The demo deliberately ends on a PDB block: that's the state worth seeing,
    // since it's the one that stops a drain completing.
    expect(pdbBlocked(last)).toHaveLength(1);
    expect(drainTone(last)).toBe("warn");
  }, 10_000);
});
