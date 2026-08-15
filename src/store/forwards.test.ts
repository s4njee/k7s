/**
 * Forward-preset store tests (B89): add/upsert-by-name/remove against
 * `forwardPresetsByCid`, per-cluster isolation, and the persisted-prefs
 * round-trip.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { connectAll, resetStore, subscribeProvider } from "../test/bootstrap";
import type { ForwardPreset } from "../providers/types";

const preset = (over: Partial<ForwardPreset>): ForwardPreset => ({
  id: "x",
  name: "web",
  kind: "services",
  namespace: "prod",
  target: "web",
  remotePort: 8080,
  ...over,
});

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

describe("forward presets (B89)", () => {
  it("adds, upserts by name, and removes a preset", async () => {
    await connectAll(["freya"]);
    useStore.getState().addForwardPreset("freya", preset({ name: "web", remotePort: 8080 }));
    expect(useStore.getState().forwardPresetsByCid["freya"]).toHaveLength(1);

    // Re-saving the same name replaces in place (the "edit" case), never dupes.
    useStore.getState().addForwardPreset("freya", preset({ name: "web", remotePort: 9090 }));
    const list = useStore.getState().forwardPresetsByCid["freya"];
    expect(list).toHaveLength(1);
    expect(list[0].remotePort).toBe(9090);

    useStore.getState().removeForwardPreset("freya", list[0].id);
    expect(useStore.getState().forwardPresetsByCid["freya"]).toHaveLength(0);
  });

  it("presets are per-cluster — no leakage across cids", async () => {
    await connectAll(["freya", "odin-staging"]);
    useStore.getState().addForwardPreset("freya", preset({ name: "web" }));
    expect(useStore.getState().forwardPresetsByCid["freya"]).toHaveLength(1);
    expect(useStore.getState().forwardPresetsByCid["odin-staging"] ?? []).toHaveLength(0);
  });

  it("presets survive the persisted-prefs round-trip (what useBootstrap writes/reads)", async () => {
    await connectAll(["freya"]);
    useStore.getState().addForwardPreset("freya", preset({ name: "web", autoRestart: true }));
    const prefs = { forwardPresets: useStore.getState().forwardPresetsByCid };
    const loaded = JSON.parse(JSON.stringify(prefs)).forwardPresets as Record<string, ForwardPreset[]>;
    expect(loaded["freya"][0].name).toBe("web");
    expect(loaded["freya"][0].autoRestart).toBe(true);
  });
});
