/**
 * Store unit tests: the log ring buffer cap and the selection/nav reset behavior
 * that the design relies on.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useStore, LOG_BUFFER_CAP } from "./store";
import type { LogLine, Row } from "./providers/types";

// Reset to a clean slate before each test (Zustand store is a singleton).
beforeEach(() => {
  useStore.setState({
    logBuffer: [],
    selectedPod: null,
    nav: "pods",
    following: true,
    openMenu: null,
    tableFilter: "",
  });
});

const line = (msg: string): LogLine => ({ ts: "", level: "INFO", msg });

const podRow = (name: string): Row => ({
  uid: `pod:prod/${name}`,
  name,
  namespace: "prod",
  cells: [],
  pod: {
    node: "n1",
    containers: ["app"],
    status: "Running",
    ready: "1/1",
    restarts: 0,
    creationTs: "",
    statusTone: "ok",
  },
});

describe("log ring buffer", () => {
  it("keeps at most LOG_BUFFER_CAP lines, dropping the oldest", () => {
    const { appendLogs } = useStore.getState();
    // Push more than the cap.
    for (let i = 0; i < LOG_BUFFER_CAP + 50; i++) appendLogs([line(`msg-${i}`)]);

    const buf = useStore.getState().logBuffer;
    expect(buf.length).toBe(LOG_BUFFER_CAP);
    // Oldest 50 were dropped; the newest line is last.
    expect(buf[0].msg).toBe(`msg-50`);
    expect(buf[buf.length - 1].msg).toBe(`msg-${LOG_BUFFER_CAP + 49}`);
  });

  it("appends a batch and caps correctly in one call", () => {
    const { appendLogs } = useStore.getState();
    const batch = Array.from({ length: LOG_BUFFER_CAP + 10 }, (_, i) => line(`b-${i}`));
    appendLogs(batch);
    expect(useStore.getState().logBuffer.length).toBe(LOG_BUFFER_CAP);
  });
});

describe("selection & nav reset", () => {
  it("selectPod opens the panel on the logs tab and clears log/view state", () => {
    useStore.setState({ activeTab: "yaml", logBuffer: [line("old")], containerIndex: 3 });
    useStore.getState().selectPod(podRow("valkyrie"));
    const s = useStore.getState();
    expect(s.selectedPod?.name).toBe("valkyrie");
    expect(s.activeTab).toBe("logs");
    expect(s.logBuffer).toEqual([]);
    expect(s.containerIndex).toBe(0);
    expect(s.following).toBe(true);
  });

  it("setNav clears the pod selection, menus, and the table filter", () => {
    useStore.setState({ selectedPod: podRow("valkyrie"), openMenu: "ns", tableFilter: "valk" });
    useStore.getState().setNav("nodes");
    const s = useStore.getState();
    expect(s.nav).toBe("nodes");
    expect(s.selectedPod).toBeNull();
    expect(s.openMenu).toBeNull();
    expect(s.tableFilter).toBe("");
  });

  it("cycleContainer advances the index and clears the buffer", () => {
    useStore.setState({ containerIndex: 0, logBuffer: [line("x")] });
    useStore.getState().cycleContainer();
    const s = useStore.getState();
    expect(s.containerIndex).toBe(1);
    expect(s.logBuffer).toEqual([]);
  });
});
