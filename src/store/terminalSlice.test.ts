/**
 * Tests for the kubectl-terminal registry (B82): open/close/activate, and the
 * guard that a terminal needs a connected cluster to target.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";

const connected = {
  prod: { phase: "connected" as const, context: "prod", clusterName: "prod" },
};

beforeEach(() => {
  useStore.setState({
    terminals: [],
    activeTerminalId: null,
    activeCid: "prod",
    connections: connected,
  });
});

describe("terminalSlice (B82)", () => {
  it("opens a terminal for a connected cluster and focuses it", () => {
    useStore.getState().openTerminal("prod");
    const s = useStore.getState();
    expect(s.terminals).toHaveLength(1);
    expect(s.terminals[0].cid).toBe("prod");
    expect(s.activeTerminalId).toBe(s.terminals[0].id);
  });

  it("no-ops when the target cluster isn't connected", () => {
    useStore.getState().openTerminal("nowhere");
    expect(useStore.getState().terminals).toHaveLength(0);
  });

  it("no-ops on an empty cid (the ⌘T/statusbar fallback)", () => {
    useStore.getState().openTerminal("");
    expect(useStore.getState().terminals).toHaveLength(0);
  });

  it("two terminals; closing the focused one focuses the other", () => {
    const s = useStore.getState();
    s.openTerminal("prod");
    s.openTerminal("prod");
    const two = useStore.getState();
    expect(two.terminals).toHaveLength(2);
    const first = two.terminals[0].id;
    two.closeTerminal(first);
    const after = useStore.getState();
    expect(after.terminals).toHaveLength(1);
    expect(after.activeTerminalId).toBe(after.terminals[0].id);
  });

  it("switching focus keeps every terminal open", () => {
    const s = useStore.getState();
    s.openTerminal("prod");
    s.openTerminal("prod");
    const two = useStore.getState();
    const first = two.terminals[0].id;
    two.setActiveTerminal(first);
    expect(useStore.getState().activeTerminalId).toBe(first);
    expect(useStore.getState().terminals).toHaveLength(2);
  });
});
