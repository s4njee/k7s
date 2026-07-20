/**
 * MockProvider — a full {@link DataProvider} backed by the prototype's static
 * data. Activated in demo mode (VITE_DEMO=1) so the entire UI runs in a plain
 * browser with no cluster. Behavior mirrors the prototype: a ~900ms log ticker,
 * an editable YAML cache, and a fixed watch count of 9.
 */

import type {
  ClusterInfo,
  ClusterStatus,
  ContextInfo,
  DataProvider,
  DrainFailure,
  DrainProgress,
  NodeSample,
  NodeStatsError,
  EventItem,
  ForwardInfo,
  ImportResult,
  LogHandle,
  LogLine,
  LogOptions,
  NodeMetricsMap,
  PodMetricsMap,
  Prefs,
  Properties,
  CustomKind,
  KindId,
  ResourceRef,
  ShellHandle,
  Row,
  SavedLog,
  Unsub,
  YamlDiff,
  NodeShellHandle,
} from "../types";
import { KIND_ORDER } from "../../lib/kinds";
import { MOCK_CLUSTERS, MOCK_CUSTOM_KINDS, MOCK_PODS, buildCustomRows, buildKindRows } from "./data";
import { makeLogLine, seedLogLines } from "./logs";
import { yamlForPodName, yamlForGeneric } from "./yaml";
import { eventsForPodName } from "./events";
import { mockProperties } from "./properties";

/** Interval (ms) between mock log lines, matching the prototype's default. */
const LOG_TICK_MS = 900;

/** Fixed status matching the prototype's status bar (v1.31, 42ms, 6/6, 41/63%). */
const MOCK_STATUS: ClusterStatus = {
  connected: true,
  version: "v1.31",
  apiLatencyMs: 42,
  nodesReady: 6,
  nodesTotal: 6,
  cpuPercent: 41,
  memPercent: 63,
};

/** Cadence of the demo node-exporter series (B27) — brisk enough to watch. */
const NODE_STATS_TICK_MS = 2000;

/** Clamp a value into a range. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Prototype shows a fixed "watch: 9 streams active". */
const MOCK_WATCH_COUNT = 9;

export class MockProvider implements DataProvider {
  // In-memory YAML edits so Apply persists within the session (like the prototype).
  private yamlCache = new Map<string, string>();

  // Live subscribers, retained so connect() can re-emit after a data reset (e.g.
  // the cluster switcher clears data on a context switch). The real backend
  // re-emits from its watchers/pollers; the mock re-emits from here.
  private resourceCbs = new Set<(kind: KindId, rows: Row[]) => void>();
  private statusCbs = new Set<(s: ClusterStatus) => void>();
  private watchCbs = new Set<(n: number) => void>();
  private customKindCbs = new Set<(k: CustomKind[]) => void>();
  private forwardCbs = new Set<(f: ForwardInfo[]) => void>();
  private drainCbs = new Set<(p: DrainProgress) => void>();
  private nodeStatsCbs = new Set<(node: string, s: NodeSample) => void>();
  private nodeStatsErrCbs = new Set<(e: NodeStatsError) => void>();
  /** Live synthetic series per node (B27), cleared by unwatchNodeStats. */
  private nodeTimers = new Map<string, ReturnType<typeof setInterval>>();

  // ---- one-shot commands ----

  async listContexts(): Promise<ContextInfo[]> {
    // Map the mock cluster list to context entries; the active one is "current".
    return MOCK_CLUSTERS.map((c) => ({ name: c.name, cluster: c.name, current: c.active }));
  }

  async connect(context: string): Promise<ClusterInfo> {
    // Re-emit all snapshots so a data reset (on switch) is repopulated.
    this.emitAllRows();
    for (const cb of this.statusCbs) cb(MOCK_STATUS);
    for (const cb of this.watchCbs) cb(MOCK_WATCH_COUNT);
    return { context, clusterName: context, server: "https://mock.local:6443", version: "v1.31" };
  }

  async importKubeconfig(): Promise<ImportResult | null> {
    // No real file dialog in demo mode; simulate importing a context so the flow
    // is demonstrable. Appended once (idempotent).
    const base = MOCK_CLUSTERS.map((c) => ({ name: c.name, cluster: c.name, current: c.active }));
    const imported: ContextInfo = {
      name: "imported-team-cluster",
      cluster: "team-eks",
      current: false,
    };
    return { contexts: [...base, imported], path: "/mock/team-cluster.kubeconfig" };
  }

  async restoreImports(_paths: string[]): Promise<string[]> {
    // Demo mode persists nothing (loadPrefs returns null), so there's never
    // anything to restore.
    return [];
  }

  /** Emit a fresh snapshot of every kind to all resource subscribers. */
  private emitAllRows(): void {
    for (const kind of KIND_ORDER) {
      const rows = buildKindRows(kind);
      for (const cb of this.resourceCbs) cb(kind, rows);
    }
  }

  async getYaml(ref: ResourceRef): Promise<string> {
    const key = `${ref.kind}:${ref.namespace}/${ref.name}`;
    // Return the edited version if the user applied changes this session.
    const cached = this.yamlCache.get(key);
    if (cached) return cached;
    // Pods get the full mock manifest; other kinds get a generic stub.
    return ref.kind === "pods"
      ? yamlForPodName(ref.name)
      : yamlForGeneric(ref.kind, ref.namespace, ref.name);
  }

  async applyYaml(ref: ResourceRef, text: string): Promise<void> {
    // Persist to the in-memory cache; no validation in demo mode.
    this.yamlCache.set(`${ref.kind}:${ref.namespace}/${ref.name}`, text);
  }

  /**
   * Simulate a server-side dry run (B36). The interesting case isn't "your text
   * comes back unchanged" — it's the server rewriting it, so the mock stamps the
   * kind of defaulting and webhook mutation a real cluster applies, which is
   * what makes the preview worth having.
   */
  async dryRunYaml(ref: ResourceRef, text: string): Promise<YamlDiff> {
    const current = await this.getYaml(ref);
    let proposed = text;
    // Defaulting: the server fills fields you didn't write.
    if (!/terminationGracePeriodSeconds:/.test(proposed)) {
      proposed = proposed.replace(/^spec:$/m, "spec:\n  terminationGracePeriodSeconds: 30");
    }
    // A mutating webhook stamping its own annotation — invisible in the text you
    // typed, which is exactly the point of previewing.
    if (!/k7s\.demo\/mutated:/.test(proposed)) {
      proposed = proposed.replace(
        /^ {2}annotations:$/m,
        "  annotations:\n    k7s.demo/mutated: \"true\"",
      );
    }
    return { current, proposed };
  }

  async getEvents(ref: ResourceRef): Promise<EventItem[]> {
    return eventsForPodName(ref.name);
  }

  async getProperties(ref: ResourceRef): Promise<Properties> {
    const props = mockProperties(ref);
    // Match the backend, which errors for kinds with no gatherer — the tab isn't
    // offered for those, so this only fires if the two lists drift apart.
    if (!props) throw new Error(`no properties for kind ${ref.kind}`);
    return props;
  }

  // Mutations are no-ops in demo mode (the data is static) — they resolve so the
  // UI flow can be exercised without a cluster.
  async deleteResource(_ref: ResourceRef): Promise<void> {}
  async scaleResource(_ref: ResourceRef, _replicas: number): Promise<void> {}
  async restartPod(_ref: ResourceRef): Promise<void> {}
  async restartRollout(_ref: ResourceRef): Promise<void> {}
  async setCordon(_node: string, _unschedulable: boolean): Promise<void> {}
  /** No native window in demo mode — the browser tab owns its own chrome. */
  async setWindowTheme(_theme: "dark" | "light"): Promise<void> {}

  /**
   * Simulate a drain (B20): tick evictions out over a couple of seconds so the
   * progress banner is demonstrable, and have one pod blocked by a PDB — that's
   * the case worth seeing, since it's the one that stops a drain finishing.
   */
  async drainNode(node: string): Promise<void> {
    const total = 6;
    let evicted = 0;
    const failures: DrainFailure[] = [];
    const tick = () => {
      if (evicted < total - 1) {
        evicted += 1;
      } else if (failures.length === 0) {
        failures.push({
          pod: "prod/yggdrasil-db-0",
          message:
            "blocked by a PodDisruptionBudget: Cannot evict pod as it would violate the pod's disruption budget.",
          blockedByPdb: true,
        });
      }
      const done = evicted >= total - 1 && failures.length > 0;
      for (const cb of this.drainCbs) cb({ node, evicted, total, failures: [...failures], done });
      if (!done) setTimeout(tick, 400);
    };
    setTimeout(tick, 300);
  }

  // Demo mode doesn't persist anything.
  async loadPrefs(): Promise<Prefs | null> {
    return null;
  }
  async savePrefs(_prefs: Prefs): Promise<void> {}

  // ---- push subscriptions ----
  //
  // The mock has no live resource stream (data is static), so onResourceUpdate
  // emits one snapshot per kind on the next tick and then stays quiet. The other
  // subscriptions emit a single initial value. Each returns a no-op unsubscribe
  // (nothing keeps running that needs teardown).

  onResourceUpdate(cb: (kind: KindId, rows: Row[]) => void): Unsub {
    this.resourceCbs.add(cb);
    // Emit asynchronously so subscribers finish wiring up before the first snapshot.
    queueMicrotask(() => {
      for (const kind of KIND_ORDER) cb(kind, buildKindRows(kind));
    });
    return () => {
      this.resourceCbs.delete(cb);
    };
  }

  // ---- custom (CRD-backed) kinds (B15) ----
  //
  // Demo mode mirrors the real lazy-watch contract: no rows exist for a custom
  // kind until it's watched, and they arrive via the same resource-update path.

  onCustomKinds(cb: (kinds: CustomKind[]) => void): Unsub {
    this.customKindCbs.add(cb);
    queueMicrotask(() => cb(MOCK_CUSTOM_KINDS));
    return () => {
      this.customKindCbs.delete(cb);
    };
  }

  async watchCustomKind(id: string): Promise<void> {
    const rows = buildCustomRows(id);
    for (const cb of this.resourceCbs) cb(id, rows);
  }

  async unwatchCustomKind(_id: string): Promise<void> {
    // Nothing to tear down: the mock has no live streams.
  }

  onPodMetrics(_cb: (metrics: PodMetricsMap) => void): Unsub {
    // Pod CPU/MEM are baked into the mock rows already, so no separate feed.
    return () => {};
  }

  onNodeMetrics(_cb: (metrics: NodeMetricsMap) => void): Unsub {
    // Node CPU/MEM percentages are baked into the mock rows already.
    return () => {};
  }

  onClusterStatus(cb: (status: ClusterStatus) => void): Unsub {
    this.statusCbs.add(cb);
    queueMicrotask(() => cb(MOCK_STATUS));
    return () => {
      this.statusCbs.delete(cb);
    };
  }

  onWatchStatus(cb: (activeStreams: number) => void): Unsub {
    this.watchCbs.add(cb);
    queueMicrotask(() => cb(MOCK_WATCH_COUNT));
    return () => {
      this.watchCbs.delete(cb);
    };
  }

  onDrainProgress(cb: (p: DrainProgress) => void): Unsub {
    this.drainCbs.add(cb);
    return () => {
      this.drainCbs.delete(cb);
    };
  }

  onNodeStats(cb: (node: string, s: NodeSample) => void): Unsub {
    this.nodeStatsCbs.add(cb);
    return () => {
      this.nodeStatsCbs.delete(cb);
    };
  }

  onNodeStatsError(cb: (e: NodeStatsError) => void): Unsub {
    this.nodeStatsErrCbs.add(cb);
    return () => {
      this.nodeStatsErrCbs.delete(cb);
    };
  }

  // ---- node-exporter statistics (B27) ----
  //
  // Demo mode synthesises a plausible series on the same cadence the real scraper
  // uses, so the plots can be worked on without a cluster. One node deliberately
  // has no exporter: the error path is as much a part of the tab as the charts.

  /**
   * Synthesise an hour of history (B38), so demo mode shows the charts opening
   * populated rather than filling one point at a time. The node with no exporter
   * has no history either — a cluster without the metrics has neither source.
   */
  async nodeHistory(node: string): Promise<NodeSample[]> {
    if (node.endsWith("06")) return [];
    const step = 30_000;
    const points = 120;
    const now = Date.now();
    const total = 64 * 1024 ** 3;
    let cpu = 20 + (node.charCodeAt(node.length - 1) % 5) * 8;
    let used = total * 0.42;
    const out: NodeSample[] = [];
    for (let i = points; i > 0; i--) {
      cpu = clamp(cpu + (Math.random() - 0.5) * 10, 1, 98);
      used = clamp(used + (Math.random() - 0.5) * 8e8, total * 0.15, total * 0.9);
      const load = (cpu / 100) * 8;
      out.push({
        ts: now - i * step,
        cpuPercent: cpu,
        memUsedBytes: used,
        memTotalBytes: total,
        netRxBps: Math.max(0, 2e6 + (Math.random() - 0.5) * 1e6),
        netTxBps: Math.max(0, 5e5 + (Math.random() - 0.5) * 3e5),
        load1: load,
        load5: load * 0.9,
        load15: load * 0.8,
        // Backfilled points carry no filesystems: the UI reads those as current.
        filesystems: [],
      });
    }
    return out;
  }

  async watchNodeStats(node: string): Promise<void> {
    if (this.nodeTimers.has(node)) return;

    if (node.endsWith("06")) {
      this.nodeStatsErrCbs.forEach((cb) =>
        cb({ node, message: `no node-exporter pod found on ${node} — install one, or its port isn't 9100` }),
      );
      return;
    }

    // A per-node seed keeps each node's curve distinct but stable across a
    // session, rather than every node drawing the same random walk.
    let cpu = 20 + (node.charCodeAt(node.length - 1) % 5) * 8;
    let rx = 2e6;
    let tx = 5e5;
    const total = 64 * 1024 ** 3;
    let used = total * 0.42;

    const tick = () => {
      // Random walks, bounded — enough to look like a machine rather than noise.
      cpu = clamp(cpu + (Math.random() - 0.5) * 14, 1, 98);
      used = clamp(used + (Math.random() - 0.5) * 1e9, total * 0.15, total * 0.9);
      rx = Math.max(0, rx + (Math.random() - 0.5) * 1.2e6);
      tx = Math.max(0, tx + (Math.random() - 0.5) * 4e5);
      const load = (cpu / 100) * 8;
      const sample: NodeSample = {
        ts: Date.now(),
        cpuPercent: cpu,
        memUsedBytes: used,
        memTotalBytes: total,
        netRxBps: rx,
        netTxBps: tx,
        load1: load,
        load5: load * 0.9,
        load15: load * 0.8,
        filesystems: [
          { mountpoint: "/", usedBytes: 67e9, sizeBytes: 1920e9 },
          { mountpoint: "/home", usedBytes: 8e9, sizeBytes: 1861e9 },
          { mountpoint: "/mnt/data", usedBytes: 9078e9, sizeBytes: 20059e9 },
        ],
      };
      this.nodeStatsCbs.forEach((cb) => cb(node, sample));
    };
    // First point promptly so the tab isn't empty while you wait.
    setTimeout(tick, 200);
    this.nodeTimers.set(node, setInterval(tick, NODE_STATS_TICK_MS));
  }

  async unwatchNodeStats(node: string): Promise<void> {
    const t = this.nodeTimers.get(node);
    if (t !== undefined) {
      clearInterval(t);
      this.nodeTimers.delete(node);
    }
  }

  // ---- log streaming ----

  async startLogs(
    ref: ResourceRef,
    container: string,
    _opts: LogOptions,
    onLines: (lines: LogLine[]) => void,
    _onClosed: (reason: string) => void,
  ): Promise<LogHandle> {
    // In "all" mode (container === "") tag each line with a rotating container name.
    const pod = MOCK_PODS.find((p) => p.name === ref.name);
    const containers = pod?.containers ?? ["app"];
    const tag = () =>
      container === "" ? containers[Math.floor(Math.random() * containers.length)] : container;
    const withTag = (lines: LogLine[]) => lines.map((l) => ({ ...l, container: tag() }));

    // Seed with history immediately, then tick a new line every LOG_TICK_MS.
    onLines(withTag(seedLogLines(ref.name)));
    const timer = setInterval(() => {
      onLines(withTag([makeLogLine(ref.name)]));
    }, LOG_TICK_MS);

    return {
      stop() {
        clearInterval(timer);
      },
    };
  }

  async saveLogs(): Promise<SavedLog | null> {
    // Demo mode is a browser page: no filesystem, and no native dialog to pick a
    // path with. Reporting "cancelled" is the honest answer — the button does
    // nothing rather than claiming to have written a file that doesn't exist.
    return null;
  }

  // ---- shell / exec (demo: a local echo shell) ----

  async startShell(
    _ref: ResourceRef,
    container: string,
    onOutput: (data: string) => void,
    _onClosed: (reason: string) => void,
  ): Promise<ShellHandle> {
    const prompt = `\x1b[32m${container}\x1b[0m:/# `;
    onOutput(`demo shell — echoes input (no real container)\r\n${prompt}`);
    return {
      input: (data: string) => {
        // Enter → newline + prompt; otherwise echo the keystroke.
        onOutput(data === "\r" ? `\r\n${prompt}` : data);
      },
      resize: () => {},
      stop: () => {},
    };
  }

  /**
   * Simulate a node debug shell (B53).
   *
   * Deliberately slow to "start": the real thing creates a pod and waits for the
   * kubelet, which on a first run means an image pull. The demo would be
   * misleading if it opened instantly, since the waiting state is a real part of
   * the experience and has its own UI.
   */
  async startNodeShell(
    node: string,
    onOutput: (data: string) => void,
    _onClosed: (reason: string) => void,
  ): Promise<NodeShellHandle> {
    const pod = `k7s-debug-${node}-1`;
    await new Promise((r) => setTimeout(r, 1200));

    const prompt = `\x1b[32mroot@${node}\x1b[0m:~# `;
    onOutput(
      `demo node shell — echoes input (no real node)\r\n` +
        `\x1b[90mreal sessions run in pod ${pod}\x1b[0m\r\n${prompt}`,
    );
    return {
      namespace: "default",
      pod,
      input: (data: string) => {
        onOutput(data === "\r" ? `\r\n${prompt}` : data);
      },
      resize: () => {},
      stop: () => {},
    };
  }

  // ---- port-forwarding (demo: fake local ports) ----
  private forwards: ForwardInfo[] = [];

  async startPortForward(ref: ResourceRef, remotePort: number): Promise<ForwardInfo> {
    const isService = ref.kind === "services";
    const fwd: ForwardInfo = {
      id: `pf-${ref.name}-${remotePort}-${this.forwards.length}`,
      namespace: ref.namespace ?? "",
      // A Service forward resolves to a backing pod; the mock fakes one so the
      // strip shows the same "service (via pod)" shape as the real thing (B16).
      pod: isService ? `${ref.name}-6c8d9-mn4p` : ref.name,
      service: isService ? ref.name : undefined,
      // A Service's targetPort commonly differs from its published port; the mock
      // mirrors that so the strip's "show what was asked for" rule is visible.
      remotePort: isService ? 8080 : remotePort,
      servicePort: isService && remotePort !== 8080 ? remotePort : undefined,
      localPort: 20000 + Math.floor(Math.random() * 10000),
    };
    this.forwards.push(fwd);
    this.emitForwards();
    return fwd;
  }

  async stopPortForward(id: string): Promise<void> {
    this.forwards = this.forwards.filter((f) => f.id !== id);
    this.emitForwards();
  }

  async listPortForwards(): Promise<ForwardInfo[]> {
    return this.forwards;
  }

  onForwards(cb: (forwards: ForwardInfo[]) => void): Unsub {
    this.forwardCbs.add(cb);
    return () => {
      this.forwardCbs.delete(cb);
    };
  }

  /** Push the current forwards, mirroring the backend's forwards-update event. */
  private emitForwards(): void {
    for (const cb of this.forwardCbs) cb([...this.forwards]);
  }
}
