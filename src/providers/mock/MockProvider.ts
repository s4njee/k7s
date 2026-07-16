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
  EventItem,
  ForwardInfo,
  LogHandle,
  LogLine,
  LogOptions,
  NodeMetricsMap,
  PodMetricsMap,
  PodProperties,
  Prefs,
  CustomKind,
  KindId,
  ResourceRef,
  ShellHandle,
  Row,
  Unsub,
} from "../types";
import { KIND_ORDER } from "../../lib/kinds";
import { MOCK_CLUSTERS, MOCK_CUSTOM_KINDS, MOCK_PODS, buildCustomRows, buildKindRows } from "./data";
import { makeLogLine, seedLogLines } from "./logs";
import { yamlForPodName, yamlForGeneric } from "./yaml";
import { eventsForPodName } from "./events";

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

  async importKubeconfig(): Promise<ContextInfo[] | null> {
    // No real file dialog in demo mode; simulate importing a context so the flow
    // is demonstrable. Appended once (idempotent).
    const base = MOCK_CLUSTERS.map((c) => ({ name: c.name, cluster: c.name, current: c.active }));
    const imported: ContextInfo = {
      name: "imported-team-cluster",
      cluster: "team-eks",
      current: false,
    };
    return [...base, imported];
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

  async getEvents(ref: ResourceRef): Promise<EventItem[]> {
    return eventsForPodName(ref.name);
  }

  async getPodProperties(ref: ResourceRef): Promise<PodProperties> {
    const pod = MOCK_PODS.find((p) => p.name === ref.name);
    const running = pod?.status === "Running";
    const containers = (pod?.containers ?? ["app"]).map((c, i) => ({
      name: c,
      image: `registry.freya.io/${c}:v2.4.1`,
      ready: running,
      restarts: i === 0 ? (pod?.restarts ?? 0) : 0,
      state: running ? "Running" : `Waiting: ${pod?.status ?? "Unknown"}`,
      cpu: "100m / 1",
      memory: "256Mi / 1Gi",
      ports: "8080/TCP",
    }));

    // Stateful mock pods get a PVC-backed volume so the storage section is shown.
    const stateful = /db|postgres|prometheus/.test(ref.name);
    const volumes = [
      ...(stateful
        ? [
            {
              name: "data",
              kind: "PVC",
              mountPaths: "/var/lib/data",
              readOnly: false,
              claim: `data-${ref.name}`,
              pv: "pvc-8f2c1a3e-4b7d-11ef-9c21",
              capacity: "20Gi",
              storageClass: "local-path",
              accessModes: "ReadWriteOnce",
              phase: "Bound",
            },
          ]
        : []),
      {
        name: "config",
        kind: "ConfigMap",
        mountPaths: "/etc/config",
        readOnly: true,
        claim: "",
        pv: "",
        capacity: "",
        storageClass: "",
        accessModes: "",
        phase: "",
      },
      {
        name: "kube-api-access",
        kind: "Projected",
        mountPaths: "/var/run/secrets/kubernetes.io/serviceaccount",
        readOnly: true,
        claim: "",
        pv: "",
        capacity: "",
        storageClass: "",
        accessModes: "",
        phase: "",
      },
    ];

    const app = ref.name.split("-").slice(0, 2).join("-");
    return {
      node: pod?.node ?? "—",
      podIp: "10.244.2.37",
      hostIp: "192.168.1.153",
      qosClass: "Burstable",
      serviceAccount: `${ref.namespace}-runtime`,
      priorityClass: "—",
      restartPolicy: "Always",
      startTime: "",
      owner: `ReplicaSet/${app}-7d9f8b64d`,
      labels: [
        { key: "app", value: app },
        { key: "version", value: "v2.4.1" },
        { key: "team", value: "platform" },
      ],
      annotations: [
        { key: "prometheus.io/scrape", value: "true" },
        { key: "prometheus.io/port", value: "9090" },
      ],
      containers,
      volumes,
      services: [
        { name: app, type: "ClusterIP", clusterIp: "10.96.14.22", ports: "8080/TCP" },
      ],
    };
  }

  // Mutations are no-ops in demo mode (the data is static) — they resolve so the
  // UI flow can be exercised without a cluster.
  async deleteResource(_ref: ResourceRef): Promise<void> {}
  async scaleResource(_ref: ResourceRef, _replicas: number): Promise<void> {}
  async setCordon(_node: string, _unschedulable: boolean): Promise<void> {}

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

  // ---- port-forwarding (demo: fake local ports) ----
  private forwards: ForwardInfo[] = [];

  async startPortForward(ref: ResourceRef, remotePort: number): Promise<ForwardInfo> {
    const fwd: ForwardInfo = {
      id: `pf-${ref.name}-${remotePort}-${this.forwards.length}`,
      namespace: ref.namespace ?? "",
      pod: ref.name,
      remotePort,
      localPort: 20000 + Math.floor(Math.random() * 10000),
    };
    this.forwards.push(fwd);
    return fwd;
  }

  async stopPortForward(id: string): Promise<void> {
    this.forwards = this.forwards.filter((f) => f.id !== id);
  }

  async listPortForwards(): Promise<ForwardInfo[]> {
    return this.forwards;
  }
}
