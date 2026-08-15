/**
 * Saved-view store tests (B60): add/upsert-by-name/remove against
 * `savedViewsByCid`, per-cluster isolation, and `applyView` setting
 * nav + namespace + filter + sort (column name resolved to index) in one update.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { connectAll, resetStore, subscribeProvider } from "../test/bootstrap";
import type { SavedView } from "../lib/views";

const v = (over: Partial<SavedView>): SavedView => ({
  id: "x",
  name: "x",
  kind: "pods",
  namespace: "all",
  filter: "",
  sortColName: null,
  sortDir: "asc",
  ...over,
});

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

describe("saved views (B60)", () => {
  it("adds, upserts by name, and removes a view", async () => {
    await connectAll(["freya"]);
    useStore.getState().addSavedView("freya", v({ name: "crashloop", filter: "status=CrashLoopBackOff" }));
    expect(useStore.getState().savedViewsByCid["freya"]).toHaveLength(1);

    // Re-saving the same name replaces in place (the "editable" case), never dupes.
    useStore.getState().addSavedView("freya", v({ name: "crashloop", filter: "status=Failed" }));
    const list = useStore.getState().savedViewsByCid["freya"];
    expect(list).toHaveLength(1);
    expect(list[0].filter).toBe("status=Failed");

    useStore.getState().removeSavedView("freya", list[0].id);
    expect(useStore.getState().savedViewsByCid["freya"]).toHaveLength(0);
  });

  it("views are per-cluster — no leakage across cids", async () => {
    await connectAll(["freya", "odin-staging"]);
    useStore.getState().addSavedView("freya", v({ name: "crashloop" }));
    expect(useStore.getState().savedViewsByCid["freya"]).toHaveLength(1);
    expect(useStore.getState().savedViewsByCid["odin-staging"] ?? []).toHaveLength(0);

    useStore.getState().setActiveCid("odin-staging");
    expect(useStore.getState().savedViewsByCid["freya"]).toHaveLength(1);
    expect(useStore.getState().savedViewsByCid["odin-staging"] ?? []).toHaveLength(0);
  });

  it("applyView sets nav, namespace, filter, and sort together", async () => {
    await connectAll(["freya"]);
    const s = useStore.getState();
    s.setNav("nodes");
    s.setNamespace("monitoring");
    s.setTableFilter("zzz");

    s.applyView(
      v({
        name: "crashloop",
        kind: "pods",
        namespace: "prod",
        filter: "status=CrashLoopBackOff",
        sortColName: "RESTARTS",
        sortDir: "desc",
      }),
    );

    const after = useStore.getState();
    expect(after.nav).toBe("pods");
    expect(after.namespace).toBe("prod");
    expect(after.tableFilter).toBe("status=CrashLoopBackOff");
    // RESTARTS is the 4th pods column (NAME, NAMESPACE, READY, RESTARTS, …).
    expect(after.sortCol).toBe(3);
    expect(after.sortDir).toBe("desc");
    expect(after.paletteOpen).toBe(false);
  });

  it("views survive a restart — the persisted prefs round-trip", async () => {
    await connectAll(["freya"]);
    useStore.getState().addSavedView("freya", v({ name: "crashloop", filter: "status=CrashLoopBackOff" }));
    // The debounced save (useBootstrap) writes savedViewsByCid into Prefs; the
    // backend persists JSON. Simulate both halves and restore into the store.
    const prefs = { savedViews: useStore.getState().savedViewsByCid };
    const loaded = JSON.parse(JSON.stringify(prefs)) as { savedViews: Record<string, unknown[]> };
    useStore.getState().addSavedView("freya", loaded.savedViews["freya"][0] as SavedView);
    expect(useStore.getState().savedViewsByCid["freya"]).toHaveLength(1);
  });

  it("a view carrying its saved columns restores that column set (B60→B87)", async () => {
    await connectAll(["freya"]);
    useStore.getState().setColumnPrefs("freya", "pods", { hidden: ["NAMESPACE"], order: null, widths: {}, custom: [] });
    useStore.getState().applyView(v({
      name: "wide",
      kind: "pods",
      columns: ["NAME", "STATUS", "CPU"],
    }));
    const prefs = useStore.getState().columnPrefsByCid["freya"]?.pods;
    expect(prefs?.order).toEqual(["NAME", "STATUS", "CPU"]);
    expect(prefs?.hidden).toEqual([]);
  });

  it("a problems view applies its scope; a non-problems view leaves scope alone", async () => {
    await connectAll(["freya"]);
    useStore.getState().setProblemsScope("all");
    useStore.getState().applyView(
      v({ name: "failures", kind: "problems", problemsScope: "active", filter: "severity=error" }),
    );
    expect(useStore.getState().nav).toBe("problems");
    expect(useStore.getState().problemsScope).toBe("active");

    useStore.getState().applyView(v({ name: "pods", kind: "pods" }));
    // A pods view doesn't touch the problems scope.
    expect(useStore.getState().problemsScope).toBe("active");
  });
});
