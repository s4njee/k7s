/**
 * Background-cluster isolation tests (B83): a connected cluster's data, updates,
 * and selection must never leak into the cluster being viewed, and must survive
 * a switch away and back. Driven against the store directly (the same setters
 * the provider events call), using the demo fixture where `web` is Running on
 * freya and CrashLoopBackOff on odin-staging — the same pod name, different data
 * per cluster, which is exactly the no-leakage check.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { connectAll, resetStore, subscribeProvider } from "../test/bootstrap";
import type { Row } from "../providers/types";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

const WEB = "web-6f9c7d5b4-abc12";
const webStatus = (rows: Row[]): string | undefined =>
  rows.find((r) => r.name === WEB)?.cells[7].text;

describe("background-cluster isolation (B83)", () => {
  it("each connected cluster keeps its own rows, and switching swaps the view", async () => {
    await connectAll(["freya", "odin-staging"]);
    const store = useStore.getState();

    // freya is active; its `web` pod is Running.
    expect(store.activeCid).toBe("freya");
    expect(webStatus(store.rows.pods)).toBe("Running");
    // odin's retained rows are already there and distinct (CrashLoopBackOff).
    expect(webStatus(store.rowsByCid["odin-staging"].pods)).toBe("CrashLoopBackOff");

    // Switch to odin: the active view becomes odin's, freya's is untouched.
    store.setActiveCid("odin-staging");
    const switched = useStore.getState();
    expect(switched.activeCid).toBe("odin-staging");
    expect(webStatus(switched.rows.pods)).toBe("CrashLoopBackOff");
    expect(webStatus(switched.rowsByCid["freya"].pods)).toBe("Running");
  });

  it("a background update to a non-active cluster does not touch the active view", async () => {
    await connectAll(["freya", "odin-staging"]);
    const store = useStore.getState();
    expect(store.activeCid).toBe("freya");

    // A new pod lands on odin while freya is being viewed.
    const extra: Row = {
      uid: "pod:default/background-probe",
      name: "background-probe",
      namespace: "default",
      cells: [{ text: "background-probe", tone: "primary" }],
    };
    store.setRows("odin-staging", "pods", [...store.rowsByCid["odin-staging"].pods, extra]);

    const after = useStore.getState();
    // The active view is still freya's — no background pod leaked in.
    expect(after.rows.pods.some((r) => r.name === "background-probe")).toBe(false);
    // The background cluster's retention took the update.
    expect(after.rowsByCid["odin-staging"].pods.some((r) => r.name === "background-probe")).toBe(
      true,
    );

    // Switch to odin: the background update is there; switch back: freya intact.
    after.setActiveCid("odin-staging");
    expect(useStore.getState().rows.pods.some((r) => r.name === "background-probe")).toBe(true);
    useStore.getState().setActiveCid("freya");
    expect(webStatus(useStore.getState().rows.pods)).toBe("Running");
  });

  it("selection is per-cluster — switching never shows one cluster's row under another", async () => {
    await connectAll(["freya", "odin-staging"]);
    useStore.getState().setNav("pods");
    const store = useStore.getState();
    const freyaWeb = store.rowsByCid["freya"].pods.find((r) => r.name === WEB);
    const odinWeb = store.rowsByCid["odin-staging"].pods.find((r) => r.name === WEB);
    if (!freyaWeb || !odinWeb) throw new Error("web pod missing from demo rows");

    store.selectRow(freyaWeb);
    expect(useStore.getState().selectedRow?.cells[7].text).toBe("Running");

    // Switching to odin: no retained selection yet, so the panel is closed —
    // freya's Running web is never shown as odin's.
    store.setActiveCid("odin-staging");
    expect(useStore.getState().selectedRow).toBeNull();

    useStore.getState().selectRow(odinWeb);
    expect(useStore.getState().selectedRow?.cells[7].text).toBe("CrashLoopBackOff");

    // Back to freya: its own selection (Running) is restored from its detail slot.
    useStore.getState().setActiveCid("freya");
    expect(useStore.getState().selectedRow?.cells[7].text).toBe("Running");
    // Both clusters' detail slots hold exactly their own rows.
    expect(useStore.getState().detailByCid["freya"].selectedRow?.cells[7].text).toBe("Running");
    expect(useStore.getState().detailByCid["odin-staging"].selectedRow?.cells[7].text).toBe(
      "CrashLoopBackOff",
    );
  });
});
