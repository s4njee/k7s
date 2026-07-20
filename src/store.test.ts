/**
 * Store unit tests: the log ring buffer cap and the selection/nav reset behavior
 * that the design relies on.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useStore, LOG_BUFFER_CAP } from "./store";
import { DEFAULT_SETTINGS } from "./lib/settings";
import type { LogLine, NodeSample, Row } from "./providers/types";

// Reset to a clean slate before each test (Zustand store is a singleton).
beforeEach(() => {
  useStore.setState({
    logBuffer: [],
    selectedRow: null,
    nav: "pods",
    following: true,
    openMenu: null,
    tableFilter: "",
    // Settings are now part of that slate: a test that raises the log cap would
    // otherwise leak it into every test that runs after it (B23).
    settings: DEFAULT_SETTINGS,
    namespace: "all",
    paletteOpen: false,
  });
});

describe("jumpTo (B28)", () => {
  const pod = (name: string, namespace: string): Row => ({
    uid: `${namespace}/${name}`,
    name,
    namespace,
    cells: [],
    pod: {
      node: "freya",
      containers: ["app"],
      status: "Running",
      ready: "1/1",
      restarts: 0,
      creationTs: "",
      statusTone: "ok",
    },
  });

  it("navigates to a kind and clears the selection", () => {
    useStore.setState({ selectedRow: pod("x", "prod") });
    useStore.getState().jumpTo("nodes");
    const s = useStore.getState();
    expect(s.nav).toBe("nodes");
    expect(s.selectedRow).toBeNull();
  });

  // The reason jumpTo exists: setNav and setNamespace each clear the selection,
  // so doing this in three calls lands on the kind with nothing selected.
  it("sets kind and selection together", () => {
    const row = pod("wiki-6b6d775f4-djpwx", "wiki");
    useStore.setState({ nav: "nodes" });
    useStore.getState().jumpTo("pods", row);
    const s = useStore.getState();
    expect(s.nav).toBe("pods");
    expect(s.selectedRow).toBe(row);
    expect(s.activeTab).toBe("logs");
  });

  it("moves the namespace filter when it would hide the row", () => {
    useStore.setState({ namespace: "prod" });
    useStore.getState().jumpTo("pods", pod("wiki-x", "wiki"));
    // Landing on an empty table because of a filter set ten minutes ago is worse
    // than the filter moving.
    expect(useStore.getState().namespace).toBe("wiki");
    expect(useStore.getState().selectedRow?.name).toBe("wiki-x");
  });

  it("leaves an 'all' filter alone — it already shows the row", () => {
    useStore.setState({ namespace: "all" });
    useStore.getState().jumpTo("pods", pod("wiki-x", "wiki"));
    expect(useStore.getState().namespace).toBe("all");
  });

  it("leaves a filter that already matches alone", () => {
    useStore.setState({ namespace: "wiki" });
    useStore.getState().jumpTo("pods", pod("wiki-x", "wiki"));
    expect(useStore.getState().namespace).toBe("wiki");
  });

  it("leaves the filter alone for a cluster-scoped row", () => {
    useStore.setState({ namespace: "prod" });
    const node: Row = { uid: "freya", name: "freya", cells: [] };
    useStore.getState().jumpTo("nodes", node);
    expect(useStore.getState().namespace).toBe("prod");
  });

  it("clears the table filter and sort, which belonged to the old kind", () => {
    useStore.setState({ tableFilter: "old", sortCol: 2, sortDir: "desc" });
    useStore.getState().jumpTo("pods", pod("x", "prod"));
    const s = useStore.getState();
    expect(s.tableFilter).toBe("");
    expect(s.sortCol).toBeNull();
  });

  it("closes the palette behind you", () => {
    useStore.setState({ paletteOpen: true });
    useStore.getState().jumpTo("nodes");
    expect(useStore.getState().paletteOpen).toBe(false);
  });

  it("opens a non-pod on YAML, matching a click", () => {
    const release: Row = { uid: "helm:kube-system/traefik", name: "traefik", namespace: "kube-system", cells: [] };
    useStore.getState().jumpTo("helm", release);
    expect(useStore.getState().activeTab).toBe("yaml");
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

  // B23's accept criterion: the cap is a setting, and a setting that only takes
  // effect after a restart isn't one.
  it("shrinking the cap trims the existing buffer immediately", () => {
    const { appendLogs, setSettings } = useStore.getState();
    appendLogs(Array.from({ length: 200 }, (_, i) => line(`m-${i}`)));
    expect(useStore.getState().logBuffer.length).toBe(200);

    setSettings({ logBufferCap: 50 });

    const buf = useStore.getState().logBuffer;
    expect(buf.length).toBe(50);
    // It keeps the newest, which is what you're looking at.
    expect(buf[buf.length - 1].msg).toBe("m-199");
    expect(buf[0].msg).toBe("m-150");
  });

  it("respects a raised cap on subsequent appends", () => {
    const { appendLogs, setSettings } = useStore.getState();
    setSettings({ logBufferCap: 500 });
    appendLogs(Array.from({ length: 400 }, (_, i) => line(`r-${i}`)));
    expect(useStore.getState().logBuffer.length).toBe(400);
  });

  it("raising the cap does not resurrect already-dropped lines", () => {
    const { appendLogs, setSettings } = useStore.getState();
    setSettings({ logBufferCap: 50 });
    appendLogs(Array.from({ length: 100 }, (_, i) => line(`d-${i}`)));
    expect(useStore.getState().logBuffer.length).toBe(50);

    setSettings({ logBufferCap: 500 });
    // They're gone from memory, not hidden — the buffer stays at what survived.
    expect(useStore.getState().logBuffer.length).toBe(50);
  });
});

/** A non-pod row (no `pod` meta). */
const plainRow = (name: string): Row => ({
  uid: `svc:prod/${name}`,
  name,
  namespace: "prod",
  cells: [],
});

describe("selection & nav reset", () => {
  it("selectRow opens a pod on the logs tab and clears log/view state", () => {
    useStore.setState({ activeTab: "yaml", logBuffer: [line("old")], containerIndex: 3 });
    useStore.getState().selectRow(podRow("valkyrie"));
    const s = useStore.getState();
    expect(s.selectedRow?.name).toBe("valkyrie");
    expect(s.activeTab).toBe("logs");
    expect(s.logBuffer).toEqual([]);
    expect(s.containerIndex).toBe(0);
    expect(s.following).toBe(true);
  });

  it("selectRow opens a non-pod row on the yaml tab (no logs)", () => {
    useStore.getState().selectRow(plainRow("valkyrie-api"));
    const s = useStore.getState();
    expect(s.selectedRow?.name).toBe("valkyrie-api");
    expect(s.activeTab).toBe("yaml");
  });

  it("setNav clears the selection, menus, and the table filter", () => {
    useStore.setState({ selectedRow: podRow("valkyrie"), openMenu: "ns", tableFilter: "valk" });
    useStore.getState().setNav("nodes");
    const s = useStore.getState();
    expect(s.nav).toBe("nodes");
    expect(s.selectedRow).toBeNull();
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

describe("navigateTo (B33: owner link / event click-through)", () => {
  const dep = (name: string, namespace: string): Row => ({
    uid: `deployments:${namespace}/${name}`,
    name,
    namespace,
    cells: [{ text: name, tone: "primary" }],
  });

  it("selects the live row when the target kind is loaded", () => {
    const row = dep("wiki", "wiki");
    useStore.setState({ rows: { deployments: [row] }, nav: "pods" });
    useStore.getState().navigateTo({ kind: "deployments", namespace: "wiki", name: "wiki" });
    const s = useStore.getState();
    expect(s.nav).toBe("deployments");
    // The real row — so the table highlights and the panel shows real cells.
    expect(s.selectedRow).toBe(row);
  });

  it("falls back to a synthetic row when the kind isn't loaded", () => {
    useStore.setState({ rows: { deployments: [] } });
    useStore
      .getState()
      .navigateTo({ kind: "deployments", namespace: "argocd", name: "argocd-repo-server" });
    const s = useStore.getState();
    expect(s.nav).toBe("deployments");
    expect(s.selectedRow?.name).toBe("argocd-repo-server");
    expect(s.selectedRow?.namespace).toBe("argocd");
    // Empty cells: the detail panel fetches by ref, so a stub row still works.
    expect(s.selectedRow?.cells).toEqual([]);
  });

  it("moves the namespace filter if it would hide the target", () => {
    useStore.setState({ rows: { deployments: [] }, namespace: "prod" });
    useStore.getState().navigateTo({ kind: "deployments", namespace: "wiki", name: "wiki" });
    expect(useStore.getState().namespace).toBe("wiki");
  });
});

describe("viewPods (B33: workload → pods)", () => {
  it("lands on pods, scoped to the workload namespace, selector in the filter", () => {
    useStore.setState({
      nav: "deployments",
      namespace: "all",
      selectedRow: { uid: "d", name: "wiki", cells: [] },
    });
    useStore.getState().viewPods("wiki", "app=wiki");
    const s = useStore.getState();
    expect(s.nav).toBe("pods");
    expect(s.namespace).toBe("wiki");
    expect(s.tableFilter).toBe("app=wiki");
    expect(s.selectedRow).toBeNull();
  });
});

describe("seedNodeSamples (B38: Prometheus backfill)", () => {
  const sample = (ts: number, cpu = 1): NodeSample => ({
    ts,
    cpuPercent: cpu,
    memUsedBytes: 1,
    memTotalBytes: 2,
    netRxBps: 0,
    netTxBps: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    filesystems: [],
  });

  beforeEach(() => useStore.setState({ nodeSamples: {} }));

  it("seeds an empty series with history, oldest first", () => {
    useStore.getState().seedNodeSamples("freya", [sample(1000), sample(2000)]);
    expect(useStore.getState().nodeSamples.freya.map((s) => s.ts)).toEqual([1000, 2000]);
  });

  it("puts history before live points", () => {
    useStore.setState({ nodeSamples: { freya: [sample(5000)] } });
    useStore.getState().seedNodeSamples("freya", [sample(3000), sample(4000)]);
    expect(useStore.getState().nodeSamples.freya.map((s) => s.ts)).toEqual([3000, 4000, 5000]);
  });

  // The two sources overlap in time; the live scrape measures the value directly
  // rather than re-deriving it from a rate over a wider window, so it wins.
  it("drops history that overlaps a live point, keeping the live reading", () => {
    useStore.setState({ nodeSamples: { freya: [sample(4000, 99)] } });
    useStore.getState().seedNodeSamples("freya", [sample(3000, 1), sample(4000, 1), sample(5000, 1)]);
    const got = useStore.getState().nodeSamples.freya;
    expect(got.map((s) => s.ts)).toEqual([3000, 4000]);
    expect(got[1].cpuPercent).toBe(99);
  });

  it("is a no-op when there's no history — the common no-Prometheus case", () => {
    useStore.setState({ nodeSamples: { freya: [sample(1000)] } });
    useStore.getState().seedNodeSamples("freya", []);
    expect(useStore.getState().nodeSamples.freya.map((s) => s.ts)).toEqual([1000]);
  });

  it("caps the merged series so a long backfill can't grow it without bound", () => {
    const history = Array.from({ length: LOG_BUFFER_CAP * 3 }, (_, i) => sample(i));
    useStore.getState().seedNodeSamples("freya", history);
    expect(useStore.getState().nodeSamples.freya.length).toBeLessThanOrEqual(240);
  });
});

describe("multi-row selection (B39)", () => {
  const r = (name: string): Row => ({ uid: `uid-${name}`, name, namespace: "prod", cells: [] });

  beforeEach(() => {
    useStore.setState({
      nav: "pods",
      namespace: "all",
      selectedRow: null,
      selection: { selected: [], anchor: null },
    });
  });

  it("setSelection replaces the selection", () => {
    useStore.getState().setSelection({ selected: ["a", "b"], anchor: "a" });
    expect(useStore.getState().selection.selected).toEqual(["a", "b"]);
  });

  /**
   * Clicking a row opens its panel; leaving a stale multi-selection behind would
   * mean the row menu acts on objects the panel isn't showing.
   */
  it("a plain row click collapses the selection to that row", () => {
    useStore.getState().setSelection({ selected: ["x", "y"], anchor: "x" });
    useStore.getState().selectRow(r("api"));
    expect(useStore.getState().selection).toEqual({ selected: ["uid-api"], anchor: "uid-api" });
  });

  /**
   * The invariant that matters: a selection is scoped to the table it was made
   * in. Surviving a nav or namespace change would let a bulk delete fire at
   * objects from a table the user has left.
   */
  it("is cleared everywhere the detail selection is", () => {
    const armed = { selected: ["a", "b"], anchor: "a" };

    useStore.getState().setSelection(armed);
    useStore.getState().setNav("services");
    expect(useStore.getState().selection.selected).toEqual([]);

    useStore.getState().setSelection(armed);
    useStore.getState().setNamespace("prod");
    expect(useStore.getState().selection.selected).toEqual([]);

    useStore.getState().setSelection(armed);
    useStore.getState().viewPods("prod", "app=x");
    expect(useStore.getState().selection.selected).toEqual([]);

    useStore.getState().setSelection(armed);
    useStore.getState().resetData();
    expect(useStore.getState().selection.selected).toEqual([]);

    useStore.getState().setSelection(armed);
    useStore.getState().jumpTo("nodes");
    expect(useStore.getState().selection.selected).toEqual([]);
  });

  it("clearSelection leaves the detail panel open", () => {
    useStore.getState().selectRow(r("api"));
    useStore.getState().setSelection({ selected: ["uid-api", "uid-b"], anchor: "uid-api" });
    useStore.getState().clearSelection();
    expect(useStore.getState().selection.selected).toEqual([]);
    expect(useStore.getState().selectedRow?.name).toBe("api");
  });
});
