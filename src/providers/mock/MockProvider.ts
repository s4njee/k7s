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
  DrainPreview,
  DrainProgress,
  UninstallOutcome,
  NodeSample,
  NodeStatsError,
  EventItem,
  ForwardInfo,
  ImportResult,
  LabelDependencies,
  LogHandle,
  LogLine,
  LogOptions,
  NodeMetricsMap,
  PodMetricsMap,
  PodPoint,
  PodSample,
  Prefs,
  Properties,
  CustomKind,
  KindId,
  ResourceRef,
  ShellHandle,
  RowUpdate,
  SavedLog,
  Topology,
  WatcherHealth,
  TopologyEdge,
  TopologyNode,
  Unsub,
  YamlDiff,
  NodeShellHandle,
} from "../types";
import { KIND_ORDER } from "../../lib/kinds";
import {
  MOCK_CLUSTERS,
  MOCK_CUSTOM_KINDS,
  MOCK_PODS,
  buildCustomRows,
  buildKindRows,
  mockPodUsage,
  workloadPods,
} from "./data";
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
  stale: false,
  lastSeenMs: Date.now(),
};

/** A fully-live watcher-health map (B74-L): every mock kind is healthy. */
function allLiveHealth(): Record<string, WatcherHealth> {
  const now = Date.now();
  const health: Record<string, WatcherHealth> = {};
  for (const kind of KIND_ORDER) health[kind] = { state: "live", lastSuccessMs: now, retries: 0 };
  return health;
}

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
  private currentContext: string | null = null;
  private resourceCbs = new Set<(cid: string, kind: KindId, update: RowUpdate) => void>();
  private statusCbs = new Set<(cid: string, s: ClusterStatus) => void>();
  private watchCbs = new Set<(cid: string, n: number) => void>();
  private healthCbs = new Set<(cid: string, h: Record<string, WatcherHealth>) => void>();
  private customKindCbs = new Set<(cid: string, k: CustomKind[]) => void>();
  private forwardCbs = new Set<(cid: string, f: ForwardInfo[]) => void>();
  private drainCbs = new Set<(cid: string, p: DrainProgress) => void>();
  private nodeStatsCbs = new Set<(cid: string, node: string, s: NodeSample) => void>();
  private nodeStatsErrCbs = new Set<(cid: string, e: NodeStatsError) => void>();
  private podStatsCbs = new Set<(cid: string, key: string, s: PodSample) => void>();
  /** Live synthetic series per node (B27), cleared by unwatchNodeStats. */
  private nodeTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Live synthetic per-pod series, cleared by unwatchPodStats. */
  private podTimers = new Map<string, ReturnType<typeof setInterval>>();

  // ---- one-shot commands ----

  async listContexts(): Promise<ContextInfo[]> {
    // Map the mock cluster list to context entries; the active one is "current".
    return MOCK_CLUSTERS.map((c) => ({ name: c.name, cluster: c.name, current: c.active }));
  }

  async connect(context: string): Promise<ClusterInfo> {
    // Re-emit all snapshots so a data reset (on switch) is repopulated (B77:
    // routed to the connected cid so the store retains per-cluster data).
    this.currentContext = context;
    this.emitAllRows();
    for (const cb of this.statusCbs) cb(context, MOCK_STATUS);
    for (const cb of this.watchCbs) cb(context, MOCK_WATCH_COUNT);
    for (const cb of this.healthCbs) cb(context, allLiveHealth());
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

  async exportContextKubeconfig(context: string): Promise<string> {
    return [
      "apiVersion: v1",
      "kind: Config",
      `current-context: ${context}`,
      "clusters:",
      `- name: ${context}`,
      "  cluster: { server: https://mock.local:6443 }",
      "contexts:",
      `- name: ${context}`,
      `  context: { cluster: ${context}, user: ${context} }`,
      "users:",
      `- name: ${context}`,
      "  user: { token: mock-token }",
      "",
    ].join("\n");
  }

  async restoreImports(_paths: string[]): Promise<string[]> {
    // Demo mode persists nothing (loadPrefs returns null), so there's never
    // anything to restore.
    return [];
  }

  /** Emit a fresh snapshot of every kind to all resource subscribers. */
  private emitAllRows(): void {
    for (const kind of KIND_ORDER) {
      const rows = buildKindRows(kind, this.currentContext ?? undefined);
      for (const cb of this.resourceCbs) cb(this.currentContext ?? "", kind, { rows });
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

  async getDiff(ref: ResourceRef): Promise<{ live: string; baseline?: string }> {
    const live = await this.getYaml(ref);
    // A demo baseline that differs from the live YAML by a label, so the Diff
    // tab has something to show: "what was applied" vs "what's live".
    const baseline = live.replace(/^metadata:\n/, "metadata:\n  labels:\n    demo: applied\n");
    return baseline === live ? { live } : { live, baseline };
  }

  async getTopology(ref: ResourceRef): Promise<Topology> {
    // A plausible demo graph mirroring the backlog's accept: a Deployment →
    // ReplicaSet → Pods chain, with a Service selecting the pods and an Ingress
    // routing to it.
    const N = (id: string, kind: string, namespace: string, name: string, nav: KindId): TopologyNode =>
      ({ id, kind, namespace, name, nav });
    const E = (from: string, to: string, rel: "ownership" | "reference"): TopologyEdge =>
      ({ from, to, rel });

    if (ref.kind === "deployments") {
      const ns = ref.namespace ?? "prod";
      const rs = `${ref.name}-6c8d9`;
      const p1 = `${rs}-mn4p`;
      const p2 = `${rs}-qq7z`;
      const seed = N(`deployments:${ns}/${ref.name}`, "Deployment", ns, ref.name, "deployments");
      const rsN = N(`replicasets:${ns}/${rs}`, "ReplicaSet", ns, rs, "replicasets");
      const p1N = N(`pods:${ns}/${p1}`, "Pod", ns, p1, "pods");
      const p2N = N(`pods:${ns}/${p2}`, "Pod", ns, p2, "pods");
      const svc = N(`services:${ns}/${ref.name}`, "Service", ns, ref.name, "services");
      const ing = N(`ingresses:${ns}/api-public`, "Ingress", ns, "api-public", "ingresses");
      return {
        nodes: [seed, rsN, p1N, p2N, svc, ing],
        edges: [
          E(seed.id, rsN.id, "ownership"),
          E(rsN.id, p1N.id, "ownership"),
          E(rsN.id, p2N.id, "ownership"),
          E(svc.id, p1N.id, "reference"),
          E(svc.id, p2N.id, "reference"),
          E(ing.id, svc.id, "reference"),
        ],
      };
    }
    // Other kinds get just the seed node — the real graph is what you see live.
    const ns = ref.namespace ?? "prod";
    return {
      nodes: [N(`${ref.kind}:${ns}/${ref.name}`, ref.kind, ns, ref.name, ref.kind)],
      edges: [],
    };
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

  async copySecretValue(_ref: ResourceRef, _key: string): Promise<void> {
    // Demo mode has no system clipboard; claim success so the copied-✓ flash is
    // exercised end to end.
  }

  // Mutations are no-ops in demo mode (the data is static) — they resolve so the
  // UI flow can be exercised without a cluster.
  async deleteResource(_ref: ResourceRef): Promise<void> {}
  async scaleResource(_ref: ResourceRef, _replicas: number): Promise<void> {}
  // Demo mode has no RBAC to consult — everything is allowed.
  async canI(): Promise<boolean> {
    return true;
  }

  async patchMetadata(): Promise<void> {
    // Demo rows are static; the editor reflects the change locally.
  }

  async labelDependencies(ref: ResourceRef, key: string): Promise<LabelDependencies> {
    // The demo's web pod is selected by a Service; removing `app` would deselect it.
    return ref.kind === "pods" && key === "app"
      ? { services: ["web-svc"], pdbs: [], networkPolicies: [] }
      : { services: [], pdbs: [], networkPolicies: [] };
  }
  async restartPod(_ref: ResourceRef): Promise<void> {}
  async restartRollout(_ref: ResourceRef): Promise<void> {}

  async undoRollout(_ref: ResourceRef, revision: number): Promise<number> {
    // Demo mode has no real Deployment to patch; claim the rollback succeeded so
    // the confirm flow and properties refresh are exercised end to end.
    return revision;
  }
  async rollbackRelease(_ref: ResourceRef, revision: number): Promise<number> {
    // Demo has no real release history to rewrite; the History table's rollback
    // buttons and refresh flow are still exercised.
    return revision + 1;
  }
  async uninstallRelease(_ref: ResourceRef): Promise<UninstallOutcome> {
    // Demo's release is static; claim success so the confirm flow completes.
    return { objectsDeleted: 2, secretsDeleted: 2 };
  }
  async setCordon(_node: string, _unschedulable: boolean): Promise<void> {}
  async setCronjobSuspend(_ref: ResourceRef, _suspended: boolean): Promise<void> {
    // Demo has no real CronJob to patch; the confirm flow is still exercised.
  }
  async runCronjob(ref: ResourceRef): Promise<string> {
    // Demo creates no real Job; claim a synthetic one so the flow completes.
    return `manual-${ref.name}-${Date.now() % 100000}`;
  }
  async retryJob(ref: ResourceRef): Promise<string> {
    return `${ref.name}-retry-${Date.now() % 100000}`;
  }
  async notifyProblem(_cid: string, _ref: ResourceRef, _reason: string): Promise<void> {
    // Demo mode is a browser tab; there's no native notification to show.
  }
  async createResource(
    yaml: string,
    _namespace: string,
    dryRun: boolean,
  ): Promise<{ proposed: string; created?: { kind: KindId; namespace?: string; name: string } }> {
    // Demo mode has no API server to create against; a dry run previews the
    // manifest as-is, a real create claims a synthetic target so the flow's
    // navigate-on-success is exercised.
    const proposed = yaml;
    const name = /name:\s*(\S+)/.exec(yaml)?.[1] ?? "created";
    const kind = (/^kind:\s*(\S+)/m.exec(yaml)?.[1] ?? "ConfigMap").toLowerCase() + "s";
    return dryRun
      ? { proposed }
      : { proposed, created: { kind: kind as KindId, namespace: "prod", name } };
  }
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
      for (const cb of this.drainCbs) cb(this.currentContext ?? "", { node, evicted, total, failures: [...failures], done });
      if (!done) setTimeout(tick, 400);
    };
    setTimeout(tick, 300);
  }

  /**
   * The preview shown before confirming a drain (B61/B80): yggdrasil-db's PDB
   * can't be disrupted on the single-node fixture, matching the block the mock
   * drain itself fakes above.
   */
  async drainPreview(node: string): Promise<DrainPreview> {
    return {
      node,
      podCount: 6,
      pdbs: [
        {
          name: "yggdrasil-db",
          namespace: "prod",
          minAvailable: "2",
          maxUnavailable: "—",
          currentHealthy: 2,
          desiredHealthy: 2,
          disruptionsAllowed: 0,
          pods: ["prod/yggdrasil-db-0", "prod/yggdrasil-db-1"],
        },
      ],
    };
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

  onResourceUpdate(cb: (cid: string, kind: KindId, update: RowUpdate) => void): Unsub {
    this.resourceCbs.add(cb);
    // Emit asynchronously so subscribers finish wiring up before the first snapshot.
    queueMicrotask(() => {
      for (const kind of KIND_ORDER) cb(this.currentContext ?? "", kind, { rows: buildKindRows(kind, this.currentContext ?? undefined) });
    });
    return () => {
      this.resourceCbs.delete(cb);
    };
  }

  // ---- custom (CRD-backed) kinds (B15) ----
  //
  // Demo mode mirrors the real lazy-watch contract: no rows exist for a custom
  // kind until it's watched, and they arrive via the same resource-update path.

  onOpenSettings(): Unsub {
    // Demo mode runs in a plain browser page with no native menu to click.
    return () => {};
  }

  onCustomKinds(cb: (cid: string, kinds: CustomKind[]) => void): Unsub {
    this.customKindCbs.add(cb);
    queueMicrotask(() => cb(this.currentContext ?? "", MOCK_CUSTOM_KINDS));
    return () => {
      this.customKindCbs.delete(cb);
    };
  }

  async watchCustomKind(id: string): Promise<void> {
    const rows = buildCustomRows(id);
    for (const cb of this.resourceCbs) cb(this.currentContext ?? "", id, { rows });
  }

  async unwatchCustomKind(_id: string): Promise<void> {
    // Nothing to tear down: the mock has no live streams.
  }

  onPodMetrics(_cb: (cid: string, metrics: PodMetricsMap) => void): Unsub {
    // Pod CPU/MEM are baked into the mock rows already, so no separate feed.
    return () => {};
  }

  onNodeMetrics(_cb: (cid: string, metrics: NodeMetricsMap) => void): Unsub {
    // Node CPU/MEM percentages are baked into the mock rows already.
    return () => {};
  }

  onClusterStatus(cb: (cid: string, status: ClusterStatus) => void): Unsub {
    this.statusCbs.add(cb);
    queueMicrotask(() => cb(this.currentContext ?? "", MOCK_STATUS));
    return () => {
      this.statusCbs.delete(cb);
    };
  }

  onWatchStatus(cb: (cid: string, activeStreams: number) => void): Unsub {
    this.watchCbs.add(cb);
    queueMicrotask(() => cb(this.currentContext ?? "", MOCK_WATCH_COUNT));
    return () => {
      this.watchCbs.delete(cb);
    };
  }

  // Per-kind watcher health (B74-L): the mock is always live.
  onWatcherHealth(cb: (cid: string, h: Record<string, WatcherHealth>) => void): Unsub {
    this.healthCbs.add(cb);
    queueMicrotask(() => cb(this.currentContext ?? "", allLiveHealth()));
    return () => {
      this.healthCbs.delete(cb);
    };
  }

  async retryKind(_cid: string, _kind: KindId): Promise<void> {
    // The mock is always healthy; a retry re-emits the live health so the UI's
    // "retrying" state clears immediately.
    const health = allLiveHealth();
    for (const cb of this.healthCbs) cb(_cid, health);
  }

  async retryCluster(cid: string): Promise<void> {
    for (const cb of this.healthCbs) cb(cid, allLiveHealth());
  }

  onDrainProgress(cb: (cid: string, p: DrainProgress) => void): Unsub {
    this.drainCbs.add(cb);
    return () => {
      this.drainCbs.delete(cb);
    };
  }

  onNodeStats(cb: (cid: string, node: string, s: NodeSample) => void): Unsub {
    this.nodeStatsCbs.add(cb);
    return () => {
      this.nodeStatsCbs.delete(cb);
    };
  }

  onNodeStatsError(cb: (cid: string, e: NodeStatsError) => void): Unsub {
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

  /**
   * Synthesise half an hour of CPU/MEM history (B44) so demo mode shows the
   * header sparklines populated. The walk ends near the pod's current mock
   * usage, so the history reads plausibly into what the Metrics tab shows now.
   * A pod demo data has no usage for gets no history either.
   */
  async podHistory(namespace: string, name: string): Promise<PodPoint[]> {
    const current = mockPodUsage(`${namespace}/${name}`);
    if (!current) return [];
    const step = 30_000;
    const points = 60;
    const now = Date.now();
    const out: PodPoint[] = [];
    for (let i = points; i > 0; i--) {
      // Oldest point is ~half of current usage; the target rises to current as
      // we approach now, with a little noise so it reads like a live machine.
      const f = (points - i) / (points - 1);
      const targetCpu = current.cpuMillis * (0.5 + 0.5 * f);
      const targetMem = current.memBytes * (0.55 + 0.45 * f);
      out.push({
        ts: now - i * step,
        cpuMillis: Math.max(0, targetCpu + (Math.random() - 0.5) * current.cpuMillis * 0.08),
        memBytes: Math.max(0, targetMem + (Math.random() - 0.5) * current.memBytes * 0.04),
      });
    }
    return out;
  }

  async watchNodeStats(node: string): Promise<void> {
    if (this.nodeTimers.has(node)) return;

    if (node.endsWith("06")) {
      this.nodeStatsErrCbs.forEach((cb) =>
        cb(this.currentContext ?? "", {
          node,
          message: `no node-exporter pod found on ${node} — install one, or its port isn't 9100`,
        }),
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
      this.nodeStatsCbs.forEach((cb) => cb(this.currentContext ?? "", node, sample));
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

  // ---- per-pod statistics ----
  //
  // Demo mode has no metrics-server, so it synthesises a plausible CPU/memory
  // series on the same cadence a pod's Metrics tab would see from the real feed,
  // letting the tab be worked on without a cluster.

  onPodStats(cb: (cid: string, key: string, s: PodSample) => void): Unsub {
    this.podStatsCbs.add(cb);
    return () => {
      this.podStatsCbs.delete(cb);
    };
  }

  async watchPodStats(key: string): Promise<void> {
    if (this.podTimers.has(key)) return;

    // Centre the walk on the pod's declared usage so it hovers near its request
    // and under its limit — the overlay lines (derived from the same usage in
    // mockPodResources) then read as a coherent picture rather than noise.
    const base = mockPodUsage(key);
    const baseCpu = base && base.cpuMillis > 0 ? base.cpuMillis : 40;
    const baseMem = base && base.memBytes > 0 ? base.memBytes : 96 * 1024 * 1024;
    let cpu = baseCpu;
    let mem = baseMem;

    const tick = () => {
      // Bounds sit below 2x base, keeping usage under the 2x-base limit line.
      cpu = clamp(cpu + (Math.random() - 0.5) * baseCpu * 0.18, Math.max(1, baseCpu * 0.4), baseCpu * 2.1);
      mem = clamp(mem + (Math.random() - 0.5) * baseMem * 0.12, baseMem * 0.5, baseMem * 2.0);
      const sample: PodSample = { ts: Date.now(), cpuMillis: Math.round(cpu), memBytes: Math.round(mem) };
      this.podStatsCbs.forEach((cb) => cb(this.currentContext ?? "", key, sample));
    };
    // First point promptly so the tab isn't empty while you wait.
    setTimeout(tick, 200);
    this.podTimers.set(key, setInterval(tick, NODE_STATS_TICK_MS));
  }

  async unwatchPodStats(key: string): Promise<void> {
    const t = this.podTimers.get(key);
    if (t !== undefined) {
      clearInterval(t);
      this.podTimers.delete(key);
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

  // ---- workload log bundle (B31) ----
  // Demo mirror of the backend bundle: one line per pod per tick, each tagged
  // with its pod, so the Logs tab can show the interleaving + distinct prefixes.

  async startWorkloadLogs(
    ref: ResourceRef,
    _opts: LogOptions,
    onLines: (lines: LogLine[]) => void,
    _onClosed: (reason: string) => void,
  ): Promise<LogHandle> {
    const pods = workloadPods(ref.name);
    // Seed a little history per pod, then tick a line from each.
    onLines(pods.flatMap((pod) => seedLogLines(pod, 6).map((l) => ({ ...l, pod }))));
    const timer = setInterval(() => {
      onLines(pods.map((pod) => ({ ...makeLogLine(pod), pod })));
    }, LOG_TICK_MS);
    return {
      stop() {
        clearInterval(timer);
      },
    };
  }

  async saveWorkloadLogs(): Promise<SavedLog | null> {
    // Same as saveLogs: demo mode has no filesystem to write to.
    return null;
  }

  async saveCsv(): Promise<SavedLog | null> {
    // Demo mode has no filesystem; the save button stays silent (cancelled).
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

  async startKubectlTerminal(
    cid: string,
    onOutput: (data: string) => void,
    _onClosed: (reason: string) => void,
  ): Promise<ShellHandle> {
    const prompt = `\x1b[32m${cid}\x1b[0m % `;
    onOutput(`demo kubectl terminal — echoes input (no real shell)\r\n${prompt}`);
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
      cid: this.currentContext ?? "",
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

  onForwards(cb: (cid: string, forwards: ForwardInfo[]) => void): Unsub {
    this.forwardCbs.add(cb);
    return () => {
      this.forwardCbs.delete(cb);
    };
  }

  /** Push the current forwards, mirroring the backend's forwards-update event. */
  private emitForwards(): void {
    for (const cb of this.forwardCbs) cb(this.currentContext ?? "", [...this.forwards]);
  }
}
