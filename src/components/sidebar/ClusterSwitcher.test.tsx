/**
 * Cluster switch component tests (B83): the rail switches instantly between
 * connected clusters without touching the other cluster's retained data, and the
 * dropdown connects a not-yet-connected context through `connectTo`. Runs against
 * the demo MockProvider, whose `perClusterPods` fixture gives `web` a distinct
 * status per cluster — Running on freya, CrashLoopBackOff elsewhere — so the
 * no-leakage check is visible in the data itself.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClusterSwitcher } from "./ClusterSwitcher";
import { useStore } from "../../store";
import { connectAll, DEMO_CLUSTERS, resetStore, subscribeProvider } from "../../test/bootstrap";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

describe("ClusterSwitcher (B83)", () => {
  it("renders a rail chip per connected cluster and connects the first context", async () => {
    await connectAll(DEMO_CLUSTERS);
    render(<ClusterSwitcher />);

    // Three connected clusters → three rail chips (the rail only renders with >1).
    for (const cid of DEMO_CLUSTERS) {
      expect(screen.getByTitle(cid)).toBeInTheDocument();
    }
    // The switcher shows the active cluster's name.
    expect(screen.getByText("freya")).toBeInTheDocument();
  });

  it("switching clusters retains the outgoing cluster's rows and swaps the view", async () => {
    await connectAll(DEMO_CLUSTERS);
    const store = useStore.getState();
    expect(store.activeCid).toBe("freya");
    // freya's `web` pod is Running; odin-staging's is CrashLoopBackOff.
    const freyaWeb = store.rowsByCid["freya"].pods.find((r) => r.name === "web-6f9c7d5b4-abc12");
    expect(freyaWeb?.cells[7].text).toBe("Running");

    const user = userEvent.setup();
    render(<ClusterSwitcher />);
    await user.click(screen.getByTitle("odin-staging"));

    const after = useStore.getState();
    expect(after.activeCid).toBe("odin-staging");
    // The active view now shows odin's data…
    const odinWeb = after.rows.pods.find((r) => r.name === "web-6f9c7d5b4-abc12");
    expect(odinWeb?.cells[7].text).toBe("CrashLoopBackOff");
    // …and odin has a pod freya doesn't.
    expect(after.rows.pods.some((r) => r.name === "celery-worker-5f6a7b8c9-zz1aa")).toBe(true);
    // freya's rows are untouched for the switch back.
    expect(after.rowsByCid["freya"].pods.find((r) => r.name === "web-6f9c7d5b4-abc12")?.cells[7].text).toBe("Running");
  });

  it("the dropdown connects a context that is not connected yet", async () => {
    // Only freya connected; odin-staging appears in the dropdown as a context.
    await connectAll(["freya"]);
    const user = userEvent.setup();
    render(<ClusterSwitcher />);

    await user.click(screen.getByText("freya")); // open the switcher menu
    // The menu row shows the context name and its cluster ("odin-staging" twice:
    // name + env), both inside the same clickable row — any match works.
    await user.click(screen.getAllByText("odin-staging")[0]);

    await waitFor(() => {
      const s = useStore.getState();
      expect(s.activeCid).toBe("odin-staging");
      expect(s.connection.phase).toBe("connected");
      // Rows for the newly connected cluster landed through the real connect flow.
      expect(s.rowsByCid["odin-staging"].pods.length).toBeGreaterThan(0);
    });
  });
});
