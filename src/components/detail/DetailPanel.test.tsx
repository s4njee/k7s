/**
 * Detail-tab component tests (B83): the tab strip routes to the right content,
 * an unknown tab id falls back gracefully (a broken route is caught, not silently
 * shown), and the selected row — including which cluster it belongs to — is
 * cid-keyed, so switching clusters can never show one cluster's selection under
 * another's identity (the "broken event cid" trap).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailPanel } from "./DetailPanel";
import { useStore } from "../../store";
import { connectAll, resetStore, subscribeProvider } from "../../test/bootstrap";
import type { DetailTab } from "../../store/types";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

const WEB = "web-6f9c7d5b4-abc12";

async function selectPod(nav = "pods", name = "heimdall-auth-6b8c9d5f7-qq3rt") {
  await connectAll(["freya"]);
  useStore.getState().setNav(nav);
  const row = useStore.getState().rows.pods.find((r) => r.name === name);
  if (!row) throw new Error(`pod ${name} not in demo rows`);
  useStore.getState().selectRow(row);
}

describe("DetailPanel tabs (B83)", () => {
  it("shows the pod tab strip and routes each tab to its content", async () => {
    await selectPod();
    const user = userEvent.setup();
    render(<DetailPanel />);

    // The strip for a pod: all eight tabs (pods are a topology kind).
    for (const tab of ["Logs", "Properties", "Metrics", "Shell", "YAML", "Diff", "Topology", "Events"]) {
      expect(screen.getByText(tab)).toBeInTheDocument();
    }

    // YAML tab → the edit entry point appears once the object is fetched.
    await user.click(screen.getByText("YAML"));
    expect(await screen.findByText("✎ Edit")).toBeInTheDocument();

    // Events tab → the crash-looping pod's warnings stream in.
    await user.click(screen.getByText("Events"));
    expect(await screen.findByText("BackOff")).toBeInTheDocument();

    // A pod opens on Logs; the stream seeded history lines.
    await user.click(screen.getByText("Logs"));
    await waitFor(() => {
      expect(screen.queryByText("✎ Edit")).not.toBeInTheDocument();
    });
  });

  it("a broken tab id falls back to the header instead of a silent wrong render", async () => {
    await selectPod();
    useStore.getState().setActiveTab("bogus" as DetailTab);
    render(<DetailPanel />);

    // The panel still shows the object header (no crash, no blank)…
    expect(screen.getByText("heimdall-auth-6b8c9d5f7-qq3rt")).toBeInTheDocument();
    // …but no tab content is rendered for an id with no route.
    expect(screen.queryByText("✎ Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("BackOff")).not.toBeInTheDocument();
  });
});

describe("detail selection is cid-keyed — no leakage across clusters (B83)", () => {
  it("switching clusters swaps the selected row to the other cluster's data", async () => {
    await connectAll(["freya", "odin-staging"]);
    useStore.getState().setNav("pods");
    // Actions are stable closures, but a captured getState() snapshot goes stale
    // after a set — always re-read for assertions.
    const s = useStore.getState();
    const freyaWeb = s.rowsByCid["freya"].pods.find((r) => r.name === WEB);
    const odinWeb = s.rowsByCid["odin-staging"].pods.find((r) => r.name === WEB);
    if (!freyaWeb || !odinWeb) throw new Error("web pod missing from demo rows");

    // Select the web pod on freya (Running), then switch to odin-staging.
    s.selectRow(freyaWeb);
    expect(useStore.getState().selectedRow?.name).toBe(WEB);
    useStore.getState().setActiveCid("odin-staging");

    // Odin has no retained selection yet — the detail panel is closed, not
    // showing freya's pod under odin's name (that would be the bug).
    expect(useStore.getState().selectedRow).toBeNull();

    // Select odin's web (CrashLoopBackOff) and confirm the cluster shows its own.
    useStore.getState().selectRow(odinWeb);
    render(<DetailPanel />);
    expect(screen.getByText("odin-staging")).toBeInTheDocument();
    expect(screen.getByText("CrashLoopBackOff")).toBeInTheDocument();

    // Back to freya: the retained freya selection (Running) is restored — not
    // odin's CrashLoopBackOff leaking across.
    useStore.getState().setActiveCid("freya");
    await waitFor(() => {
      expect(useStore.getState().selectedRow?.name).toBe(WEB);
    });
    expect(useStore.getState().selectedRow?.cells[7].text).toBe("Running");
    // freya's detail slot kept its own selection all along.
    expect(useStore.getState().detailByCid["freya"].selectedRow?.cells[7].text).toBe("Running");
    expect(useStore.getState().detailByCid["odin-staging"].selectedRow?.cells[7].text).toBe(
      "CrashLoopBackOff",
    );
  });
});
