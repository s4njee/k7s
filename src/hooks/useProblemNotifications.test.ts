/**
 * Tests for the problem-notification transition rule (B50): a problem notifies
 * on the *transition into* its state — a pod that stays err never re-notifies
 * every poll tick, and one that recovers and recurs inside the cooldown stays
 * quiet until the cooldown passes.
 */

import { describe, expect, it } from "vitest";
import { dueProblems, NOTIFY_COOLDOWN } from "./useProblemNotifications";
import type { Row } from "../providers/types";

const NOW = 1_000_000_000_000;

function problem(uid: string): Row {
  return { uid, name: uid, cells: [{ text: "error", tone: "err" }] };
}

describe("dueProblems", () => {
  it("notifies a problem that just transitioned in", () => {
    const out = dueProblems([problem("p1")], new Set(), new Map(), NOW, NOTIFY_COOLDOWN);
    expect(out.map((r) => r.uid)).toEqual(["p1"]);
  });

  it("does not re-notify a problem that was already there (a crash-looper keeps its tone)", () => {
    const prev = new Set(["p1"]);
    const out = dueProblems([problem("p1")], prev, new Map(), NOW, NOTIFY_COOLDOWN);
    expect(out).toEqual([]);
  });

  it("stays quiet within the cooldown after notifying (a recurring problem doesn't spam)", () => {
    const lastNotified = new Map([["p1", NOW - 1000]]); // notified 1s ago
    const out = dueProblems([problem("p1")], new Set(), lastNotified, NOW, NOTIFY_COOLDOWN);
    expect(out).toEqual([]);
  });

  it("notifies again once the cooldown has passed", () => {
    const lastNotified = new Map([["p1", NOW - NOTIFY_COOLDOWN - 1000]]);
    const out = dueProblems([problem("p1")], new Set(), lastNotified, NOW, NOTIFY_COOLDOWN);
    expect(out.map((r) => r.uid)).toEqual(["p1"]);
  });

  it("notifies only the new problems in a mixed set", () => {
    const prev = new Set(["p1"]);
    const out = dueProblems(
      [problem("p1"), problem("p2")],
      prev,
      new Map(),
      NOW,
      NOTIFY_COOLDOWN,
    );
    expect(out.map((r) => r.uid)).toEqual(["p2"]);
  });
});
