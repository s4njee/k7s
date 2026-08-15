/**
 * Forward-manager tests (B89): renders the cluster's active forwards and
 * presets, starts a preset, edits a forward's local port (restart), shows a
 * failing forward's error, and disables presets while the cluster is stale.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForwardManager } from "./ForwardManager";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { connectAll, resetStore, subscribeProvider } from "../../test/bootstrap";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

async function openManager() {
  await connectAll(["freya"]);
  useStore.getState().setNav("pods");
  const provider = getProvider();
  // The MockProvider is a module singleton — clear any forwards a previous test
  // left, so each test starts with exactly the one it seeds.
  for (const f of await provider.listPortForwards()) await provider.stopPortForward(f.id);
  const fwd = await provider.startPortForward({ kind: "services", namespace: "prod", name: "web" }, 8080);
  useStore.getState().setPortForwards("freya", await provider.listPortForwards());
  useStore.getState().addForwardPreset("freya", {
    id: "web",
    name: "web",
    kind: "services",
    namespace: "prod",
    target: "web",
    remotePort: 8080,
  });
  useStore.getState().setForwardManagerOpen(true);
  render(<ForwardManager />);
  return fwd;
}

describe("ForwardManager (B89)", () => {
  it("renders the active forward and its preset", async () => {
    const fwd = await openManager();
    expect(screen.getByText(`localhost:${fwd.localPort}`)).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("starting a preset creates a new forward", async () => {
    await openManager();
    // Stop the seeded forward so the only remaining is the preset's start.
    const provider = getProvider();
    const list = await provider.listPortForwards();
    for (const f of list) await provider.stopPortForward(f.id);
    useStore.getState().setPortForwards("freya", []);
    const before = useStore.getState().portForwards.length;

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "start web" }));
    // The start is async through the mock provider; wait for the store to grow.
    await waitFor(() => {
      expect(useStore.getState().portForwards.length).toBeGreaterThan(before);
    });
  });

  it("a failing forward's error is shown", async () => {
    await openManager();
    const provider = getProvider();
    const list = await provider.listPortForwards();
    // The mock has no error path; surface one on the row directly.
    useStore.getState().setPortForwards(
      "freya",
      list.map((f) => ({ ...f, error: "connection refused: pod is gone" })),
    );
    expect(await screen.findByText("connection refused: pod is gone")).toBeInTheDocument();
  });

  it("editing a forward's local port restarts it with the chosen port", async () => {
    await openManager();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "edit active forward's local port" }));
    const input = screen.getByLabelText("new local port");
    await user.clear(input);
    await user.type(input, "39999");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("localhost:39999")).toBeInTheDocument();
    });
  });

  it("presets are disabled while the cluster is stale", async () => {
    await openManager();
    useStore.getState().setClusterStatus("freya", {
      connected: true,
      version: "v1.31",
      apiLatencyMs: 1,
      nodesReady: 1,
      nodesTotal: 1,
      cpuPercent: 0,
      memPercent: 0,
      stale: true,
      lastSeenMs: Date.now(),
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "start web" })).toBeDisabled();
    });
    expect(screen.getByText(/cluster offline/)).toBeInTheDocument();
  });
});
