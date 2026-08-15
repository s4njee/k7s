/**
 * Column-prefs store tests (B87): per-{cid, kind} isolation (no leak to a second
 * cluster), reset, and the persisted-prefs round-trip.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { connectAll, resetStore, subscribeProvider } from "../test/bootstrap";
import { EMPTY_COLUMN_PREFS, toggleColumnPrefs } from "../lib/columns";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

describe("column prefs (B87)", () => {
  it("stores per-{cid, kind} configs without leaking across clusters", async () => {
    await connectAll(["freya", "odin-staging"]);
    useStore.getState().setColumnPrefs("freya", "pods", toggleColumnPrefs(EMPTY_COLUMN_PREFS, "NAMESPACE"));
    expect(useStore.getState().columnPrefsByCid["freya"].pods.hidden).toEqual(["NAMESPACE"]);
    // The second cluster has no config — nothing leaked.
    expect(useStore.getState().columnPrefsByCid["odin-staging"]?.pods).toBeUndefined();
    // A different kind on the same cluster is independent too.
    useStore.getState().setColumnPrefs("freya", "nodes", EMPTY_COLUMN_PREFS);
    expect(useStore.getState().columnPrefsByCid["freya"].nodes).toBeDefined();
    expect(useStore.getState().columnPrefsByCid["freya"].pods.hidden).toEqual(["NAMESPACE"]);
  });

  it("reset removes a kind's config entirely", async () => {
    await connectAll(["freya"]);
    useStore.getState().setColumnPrefs("freya", "pods", toggleColumnPrefs(EMPTY_COLUMN_PREFS, "NAMESPACE"));
    useStore.getState().resetColumnPrefs("freya", "pods");
    expect(useStore.getState().columnPrefsByCid["freya"]?.pods).toBeUndefined();
  });

  it("survives the persisted-prefs round-trip (what useBootstrap writes/reads)", async () => {
    await connectAll(["freya"]);
    useStore.getState().setColumnPrefs("freya", "pods", toggleColumnPrefs(EMPTY_COLUMN_PREFS, "NAMESPACE"));
    const prefs = { columnPrefs: useStore.getState().columnPrefsByCid };
    const loaded = JSON.parse(JSON.stringify(prefs)).columnPrefs as Record<string, Record<string, { hidden: string[] }>>;
    expect(loaded["freya"].pods.hidden).toEqual(["NAMESPACE"]);
  });
});
