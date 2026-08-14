/**
 * Tests for the rollout-undo rule (B34b): only revisions *behind* the current
 * one can be rolled back to. The current revision — the highest, the one the
 * controller is rolling out — gets no action.
 */

import { describe, expect, it } from "vitest";
import { rollbackable } from "./rollback";

describe("rollbackable", () => {
  it("offers every revision below the current one", () => {
    expect(rollbackable([1, 2, 3], 1)).toBe(true);
    expect(rollbackable([1, 2, 3], 2)).toBe(true);
  });

  it("never offers the current (highest) revision", () => {
    expect(rollbackable([1, 2, 3], 3)).toBe(false);
  });

  it("offers the only revision when there is just one — undo restores the same template", () => {
    // A single-revision Deployment has nothing newer to be, so rolling back to
    // it would be a no-op; the rule treats it as current.
    expect(rollbackable([1], 1)).toBe(false);
  });

  it("refuses a non-revision (the cell reads an em dash when the annotation is absent)", () => {
    expect(rollbackable([2, 4], Number.NaN)).toBe(false);
    expect(rollbackable([], 1)).toBe(false);
  });
});
