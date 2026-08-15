/**
 * Tests for the B74-L watcher-health state: per-{cid,kind} health is retained
 * per cluster, mirrors to the active slice, and never touches the rows it
 * reports on — a forbidden kind is a health state, not an empty table.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";

const live = (): Record<string, { state: "live"; lastSuccessMs: number; retries: number }> => ({
  pods: { state: "live", lastSuccessMs: Date.now(), retries: 0 },
});

const forbiddenSecrets = {
  secrets: {
    state: "forbidden" as const,
    retries: 3,
    error: {
      code: "forbidden",
      message: "permission denied",
      retryable: false,
      action: { label: "Check permissions", hint: "ask your admin" },
      kind: "secrets",
      detail: "Api(...403)",
    },
  },
};

beforeEach(() => {
  useStore.setState({
    activeCid: "prod",
    connections: { prod: { phase: "connected", context: "prod", clusterName: "prod" } },
    watcherHealthByCid: {},
    watcherHealth: {},
    rowsByCid: {},
    rows: {},
  });
});

describe("watcherHealth slice (B74-L)", () => {
  it("retains per-cid health and mirrors it to the active slice", () => {
    const s = useStore.getState();
    s.setWatcherHealth("prod", live());
    // Non-active cluster: retained only.
    s.setWatcherHealth("staging", forbiddenSecrets);
    expect(useStore.getState().watcherHealthByCid["prod"].pods.state).toBe("live");
    expect(useStore.getState().watcherHealthByCid["staging"].secrets.state).toBe("forbidden");
    // Active mirror reflects the active cid's map.
    expect(useStore.getState().watcherHealth.pods.state).toBe("live");
    expect(useStore.getState().watcherHealth.secrets).toBeUndefined();
  });

  it("a forbidden kind keeps its rows (it is not an empty table)", () => {
    const s = useStore.getState();
    s.setRows("prod", "secrets", [
      { uid: "u1", name: "creds", cells: [{ text: "creds", tone: "primary" }] },
    ]);
    s.setWatcherHealth("prod", forbiddenSecrets);
    const after = useStore.getState();
    expect(after.rowsByCid["prod"].secrets).toHaveLength(1);
    expect(after.watcherHealth.secrets.state).toBe("forbidden");
    // Rows aren't cleared when health reports a failure.
    expect(after.rows.secrets).toHaveLength(1);
  });

  it("switching clusters swaps the active health mirror", () => {
    const s = useStore.getState();
    s.setWatcherHealth("prod", live());
    s.setWatcherHealth("staging", forbiddenSecrets);
    s.setActiveCid("staging");
    expect(useStore.getState().watcherHealth.secrets.state).toBe("forbidden");
    expect(useStore.getState().watcherHealth.pods).toBeUndefined();
  });
});
