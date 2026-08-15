/**
 * TauriProvider — the real {@link DataProvider}, bridging to the Rust backend via
 * Tauri `invoke` (commands) and `listen` (events). Used in non-demo builds.
 *
 * Event names and payload shapes mirror src-tauri/src/kube/mod.rs (`events`) and
 * the DTOs there. The `on*` subscriptions return a synchronous unsubscribe that
 * detaches the underlying async Tauri listener once it's attached.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { exportFilename } from "../../lib/logview";
import type {
  ClusterInfo,
  ClusterStatus,
  ContextInfo,
  DataProvider,
  DrainPreview,
  DrainProgress,
  NodeSample,
  PodPoint,
  NodeStatsError,
  EventItem,
  ForwardInfo,
  ImportResult,
  LogHandle,
  LogLine,
  LogOptions,
  NodeShellHandle,
  NodeMetricsMap,
  PodMetricsMap,
  PodSample,
  Prefs,
  Properties,
  CustomKind,
  KindId,
  ResourceRef,
  ShellHandle,
  Row,
  RowUpdate,
  SavedLog,
  Topology,
  Unsub,
  YamlDiff,
} from "../types";

/** Wire payload for the `resource-update` event (B78): delta or full snapshot. */
interface ResourceUpdatePayload {
  /** Built-in kind id, or a custom kind's "group/plural" id (B15). */
  kind: KindId;
  rows?: Row[];
  upserts?: Row[];
  deletes?: string[];
}

/**
 * Attach a Tauri event listener and return a synchronous unsubscribe. `listen` is
 * async, so we hold the unlisten fn once resolved and also guard against the
 * caller unsubscribing before attachment completes.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): Unsub {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  void listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    // If unsubscribed before the listener attached, detach immediately.
    if (cancelled) fn();
    else unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export class TauriProvider implements DataProvider {
  // ---- pod-stats fanout (see watchPodStats / onPodStats) ----
  //
  // A pod's Metrics tab is fed by filtering the cluster-wide `pod-metrics` event
  // down to the pods being watched, rather than a dedicated backend stream: the
  // poller is already running, so this is a pure client-side fanout.
  private watchedPods = new Set<string>();
  private podStatsCbs = new Set<(cid: string, key: string, sample: PodSample) => void>();

  // ---- clusters (B76/B77) ----
  //
  // The backend holds several clusters side-by-side; the provider tracks the
  // *active* one (which command calls target) and subscribes to EVERY connected
  // cluster's `{event}:{cid}` channels so the store retains background data.
  // The on* callbacks below register a handler per channel; connect() adds the
  // new cid's subscriptions and the store routes each event by cid.
  private cid: string | null = null;
  private subscribedCids = new Set<string>();
  private clusterUnsubs: (() => void)[] = [];
  private throttledSubs: (() => void)[] = [];
  // A `throttle` handler (B78) is high-churn (rows at 50/sec, per-node stats) and
  // only subscribed for the ACTIVE cluster — an unviewed background cluster's
  // rows cost no IPC, per the 10k-object accept. Low-churn channels
  // (cluster-status, watch-status, pod-metrics, …) stay live for every connected
  // cluster so the rail dots and switch-back stay fresh.
  private clusterHandlers: {
    event: string;
    handler: (cid: string, p: unknown) => void;
    throttle?: boolean;
  }[] = [];

  /** Invoke a backend command with the active cid injected. Commands that don't
   *  take one ignore it (serde drops unknown fields). */
  private invokeCmd<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>(cmd, { cid: this.cid, ...args });
  }

  /** Subscribe `cid`'s low-churn channels (throttle'd handlers are active-only). */
  private subscribeCid(cid: string): void {
    if (this.subscribedCids.has(cid)) return;
    this.subscribedCids.add(cid);
    for (const { event, handler, throttle } of this.clusterHandlers) {
      if (throttle) continue;
      this.clusterUnsubs.push(subscribe(`${event}:${cid}`, (p: unknown) => handler(cid, p)));
    }
  }

  /** Swap the active cluster's high-churn subscriptions to a new cid. */
  private activateCid(cid: string): void {
    for (const u of this.throttledSubs) u();
    this.throttledSubs = [];
    this.cid = cid;
    for (const { event, handler, throttle } of this.clusterHandlers) {
      if (!throttle) continue;
      this.throttledSubs.push(subscribe(`${event}:${cid}`, (p: unknown) => handler(cid, p)));
    }
  }

  /** Register a cluster-channel handler; subscribed for every connected cid. */
  private subscribeCluster<T>(
    event: string,
    handler: (cid: string, p: T) => void,
    opts?: { throttle?: boolean },
  ): Unsub {
    const entry = { event, handler: handler as (cid: string, p: unknown) => void, throttle: opts?.throttle };
    this.clusterHandlers.push(entry);
    if (entry.throttle) {
      if (this.cid) this.activateCid(this.cid);
    } else {
      for (const cid of this.subscribedCids) this.subscribeCid(cid);
    }
    return () => {
      const i = this.clusterHandlers.indexOf(entry);
      if (i >= 0) this.clusterHandlers.splice(i, 1);
    };
  }

  // ---- one-shot commands ----

  listContexts(): Promise<ContextInfo[]> {
    return this.invokeCmd<ContextInfo[]>("list_contexts");
  }

  async connect(context: string): Promise<ClusterInfo> {
    // Switch the active cid (B78: only the active cluster's high-churn rows
    // flow; the new cid's throttle channels re-attach here), add its low-churn
    // channels if new, then invoke — the reuse path's replayed snapshots land
    // on the new channels (B76).
    this.activateCid(context);
    this.subscribeCid(context);
    return this.invokeCmd<ClusterInfo>("connect", { context });
  }

  restoreImports(paths: string[]): Promise<string[]> {
    return this.invokeCmd<string[]>("restore_imports", { paths });
  }

  async importKubeconfig(): Promise<ImportResult | null> {
    // Lazy-import the dialog plugin so it isn't pulled into demo bundles.
    const { open } = await import("@tauri-apps/plugin-dialog");
    // Pre-point the dialog at kubectl's default kubeconfig for one-click import.
    const defaultPath = await this.invokeCmd<string>("default_kubeconfig_path");
    const selected = await open({
      title: "Import kubeconfig",
      multiple: false,
      directory: false,
      defaultPath: defaultPath || undefined,
    });
    // User cancelled, or (defensively) a multi-selection came back.
    if (!selected || Array.isArray(selected)) return null;
    const contexts = await this.invokeCmd<ContextInfo[]>("import_kubeconfig", { path: selected });
    // The path goes back to the caller so it can be persisted (B17); only the
    // provider knows it, since the picker lives here.
    return { contexts, path: selected };
  }

  exportContextKubeconfig(context: string): Promise<string> {
    return this.invokeCmd<string>("export_context_kubeconfig", { context });
  }

  getYaml(ref: ResourceRef): Promise<string> {
    return this.invokeCmd<string>("get_yaml", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  applyYaml(ref: ResourceRef, text: string): Promise<void> {
    return this.invokeCmd<void>("apply_yaml", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      yaml: text,
    });
  }

  dryRunYaml(ref: ResourceRef, text: string): Promise<YamlDiff> {
    return this.invokeCmd<YamlDiff>("dry_run_yaml", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      yaml: text,
    });
  }

  getEvents(ref: ResourceRef): Promise<EventItem[]> {
    return this.invokeCmd<EventItem[]>("get_events", {
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  getProperties(ref: ResourceRef): Promise<Properties> {
    return this.invokeCmd<Properties>("get_properties", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  copySecretValue(ref: ResourceRef, key: string): Promise<void> {
    // The value is decoded and written to the clipboard in Rust; the webview
    // never sees it (B37).
    return this.invokeCmd<void>("copy_secret_value", {
      namespace: ref.namespace ?? "",
      name: ref.name,
      key,
    });
  }

  deleteResource(ref: ResourceRef): Promise<void> {
    return this.invokeCmd<void>("delete_resource", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  scaleResource(ref: ResourceRef, replicas: number): Promise<void> {
    return this.invokeCmd<void>("scale_resource", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      replicas,
    });
  }

  restartPod(ref: ResourceRef): Promise<void> {
    return this.invokeCmd<void>("restart_pod", {
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  restartRollout(ref: ResourceRef): Promise<void> {
    return this.invokeCmd<void>("restart_rollout", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  undoRollout(ref: ResourceRef, revision: number): Promise<number> {
    return this.invokeCmd<number>("undo_rollout", {
      namespace: ref.namespace ?? "",
      name: ref.name,
      revision,
    });
  }

  setCordon(node: string, unschedulable: boolean): Promise<void> {
    return this.invokeCmd<void>("set_cordon", { name: node, unschedulable });
  }

  setCronjobSuspend(ref: ResourceRef, suspended: boolean): Promise<void> {
    return this.invokeCmd<void>("set_cronjob_suspend", {
      namespace: ref.namespace ?? "",
      name: ref.name,
      suspended,
    });
  }

  runCronjob(ref: ResourceRef): Promise<string> {
    return this.invokeCmd<string>("run_cronjob", {
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  retryJob(ref: ResourceRef): Promise<string> {
    return this.invokeCmd<string>("retry_job", {
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  notifyProblem(_cid: string, ref: ResourceRef, reason: string): Promise<void> {
    return this.invokeCmd<void>("notify_problem", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      reason,
    });
  }

  createResource(
    yaml: string,
    namespace: string,
    dryRun: boolean,
  ): Promise<{ proposed: string; created?: { kind: KindId; namespace?: string; name: string } }> {
    return this.invokeCmd("create_resource", { yaml, namespace, dryRun });
  }

  getDiff(ref: ResourceRef): Promise<{ live: string; baseline?: string }> {
    return this.invokeCmd("get_diff", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  getTopology(ref: ResourceRef): Promise<Topology> {
    return this.invokeCmd<Topology>("get_topology", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  drainNode(node: string): Promise<void> {
    return this.invokeCmd<void>("drain_node", { name: node });
  }

  drainPreview(node: string): Promise<DrainPreview> {
    return this.invokeCmd<DrainPreview>("drain_preview", { name: node });
  }

  async setWindowTheme(theme: "dark" | "light"): Promise<void> {
    // Lazy-imported like the dialog plugin, so it isn't pulled into demo bundles.
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // Cosmetic: a failure here leaves a mismatched titlebar, which is not worth
    // surfacing as an error over the app content.
    try {
      await getCurrentWindow().setTheme(theme);
    } catch {
      /* older webview / platform without theme control */
    }
  }

  // ---- node-exporter statistics (B27) ----

  nodeHistory(node: string): Promise<NodeSample[]> {
    return this.invokeCmd<NodeSample[]>("node_history", { node });
  }

  podHistory(namespace: string, name: string): Promise<PodPoint[]> {
    return this.invokeCmd<PodPoint[]>("pod_history", { namespace, name });
  }

  watchNodeStats(node: string): Promise<void> {
    return this.invokeCmd<void>("watch_node_stats", { node });
  }

  unwatchNodeStats(node: string): Promise<void> {
    return this.invokeCmd<void>("unwatch_node_stats", { node });
  }

  // ---- per-pod statistics ----

  async watchPodStats(key: string): Promise<void> {
    // No backend call: the metrics poller already runs cluster-wide. This just
    // marks the pod so the fanout forwards its samples.
    this.watchedPods.add(key);
  }

  async unwatchPodStats(key: string): Promise<void> {
    this.watchedPods.delete(key);
  }

  loadPrefs(): Promise<Prefs | null> {
    return this.invokeCmd<Prefs | null>("load_prefs");
  }

  savePrefs(prefs: Prefs): Promise<void> {
    return this.invokeCmd<void>("save_prefs", { prefs });
  }

  // ---- push subscriptions ----

  // ---- custom (CRD-backed) kinds (B15) ----

  watchCustomKind(id: string): Promise<void> {
    return this.invokeCmd("watch_custom_kind", { kind: id });
  }

  unwatchCustomKind(id: string): Promise<void> {
    return this.invokeCmd("unwatch_custom_kind", { kind: id });
  }

  onOpenSettings(cb: () => void): Unsub {
    // Emitted by the native File > Settings… menu item (see src-tauri setup_menu).
    return subscribe<unknown>("settings-open", () => cb());
  }

  onCustomKinds(cb: (cid: string, kinds: CustomKind[]) => void): Unsub {
    return this.subscribeCluster<CustomKind[]>("custom-kinds", cb);
  }

  onResourceUpdate(cb: (cid: string, kind: KindId, update: RowUpdate) => void): Unsub {
    return this.subscribeCluster<ResourceUpdatePayload>(
      "resource-update",
      (cid, p) => {
        if (p.rows !== undefined) cb(cid, p.kind, { rows: p.rows });
        else cb(cid, p.kind, { upserts: p.upserts ?? [], deletes: p.deletes ?? [] });
      },
      { throttle: true }, // B78: 50/sec rows; background clusters don't get these
    );
  }

  onPodMetrics(cb: (cid: string, metrics: PodMetricsMap) => void): Unsub {
    return this.subscribeCluster<PodMetricsMap>("pod-metrics", cb);
  }

  onNodeMetrics(cb: (cid: string, metrics: NodeMetricsMap) => void): Unsub {
    return this.subscribeCluster<NodeMetricsMap>("node-metrics", cb);
  }

  onClusterStatus(cb: (cid: string, status: ClusterStatus) => void): Unsub {
    return this.subscribeCluster<ClusterStatus>("cluster-status", cb);
  }

  onWatchStatus(cb: (cid: string, activeStreams: number) => void): Unsub {
    return this.subscribeCluster<number>("watch-status", cb);
  }

  onDrainProgress(cb: (cid: string, progress: DrainProgress) => void): Unsub {
    return this.subscribeCluster<DrainProgress>("drain-progress", cb);
  }

  onNodeStats(cb: (cid: string, node: string, sample: NodeSample) => void): Unsub {
    return this.subscribeCluster<{ node: string; sample: NodeSample }>(
      "node-stats",
      (cid, p) => cb(cid, p.node, p.sample),
      { throttle: true }, // per-scrape; active cluster only (B78)
    );
  }

  onNodeStatsError(cb: (cid: string, err: NodeStatsError) => void): Unsub {
    return this.subscribeCluster<NodeStatsError>("node-stats-error", cb, { throttle: true });
  }

  onPodStats(cb: (cid: string, key: string, sample: PodSample) => void): Unsub {
    this.podStatsCbs.add(cb);
    // Attach the shared `pod-metrics` fanout on first use. The backend doesn't
    // timestamp samples, so each poll is stamped with its arrival time here.
    this.registerPodFanout();
    return () => {
      this.podStatsCbs.delete(cb);
    };
  }

  /** One per-cid `pod-metrics` listener feeding every watched-pod callback. */
  private podFanoutRegistered = false;
  private registerPodFanout(): void {
    if (this.podFanoutRegistered) return;
    this.podFanoutRegistered = true;
    this.subscribeCluster<PodMetricsMap>("pod-metrics", (cid, map) => {
      if (this.watchedPods.size === 0) return;
      const ts = Date.now();
      for (const key of this.watchedPods) {
        const m = map[key];
        if (!m) continue;
        const sample: PodSample = { ts, cpuMillis: m.cpuMillis, memBytes: m.memBytes };
        for (const fn of this.podStatsCbs) fn(cid, key, sample);
      }
    });
  }

  // ---- log streaming ----

  async startLogs(
    ref: ResourceRef,
    container: string,
    opts: LogOptions,
    onLines: (lines: LogLine[]) => void,
    onClosed: (reason: string) => void,
  ): Promise<LogHandle> {
    // Start the backend stream first so we know its id, then attach listeners to
    // the id-scoped events.
    const streamId = await this.invokeCmd<string>("start_log_stream", {
      namespace: ref.namespace ?? "",
      pod: ref.name,
      container,
      tail: opts.tail ?? null,
      sinceTime: opts.sinceTime ?? null,
      sinceSeconds: opts.sinceSeconds ?? null,
      previous: opts.previous ?? false,
    });

    const offLine = subscribe<{ lines: LogLine[] }>(`log-line:${this.cid}:${streamId}`, (p) => onLines(p.lines));
    const offClosed = subscribe<string>(`log-closed:${this.cid}:${streamId}`, onClosed);

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        offLine();
        offClosed();
        // Fire-and-forget: cancel the backend task.
        void this.invokeCmd("stop_log_stream", { streamId });
      },
    };
  }

  async saveLogs(
    ref: ResourceRef,
    container: string,
    opts: { sinceSeconds?: number; previous?: boolean },
  ): Promise<SavedLog | null> {
    // Lazy-import the dialog plugin so it isn't pulled into demo bundles.
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "Save logs",
      defaultPath: exportFilename(ref.name, container, opts.previous ?? false),
      filters: [{ name: "Log", extensions: ["log", "txt"] }],
    });
    if (!path) return null; // cancelled

    // The backend writes the file itself: a container's whole log can be tens of
    // megabytes, and there's no reason to drag that through the IPC bridge and
    // the webview's heap just to write it back out to disk.
    const lines = await this.invokeCmd<number>("export_logs", {
      namespace: ref.namespace ?? "",
      pod: ref.name,
      container,
      sinceSeconds: opts.sinceSeconds ?? null,
      previous: opts.previous ?? false,
      path,
    });
    return { path, lines };
  }

  // ---- workload log bundle (B31) ----

  async startWorkloadLogs(
    ref: ResourceRef,
    opts: LogOptions,
    onLines: (lines: LogLine[]) => void,
    onClosed: (reason: string) => void,
  ): Promise<LogHandle> {
    const streamId = await this.invokeCmd<string>("start_workload_logs", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      tail: opts.tail ?? null,
      sinceTime: opts.sinceTime ?? null,
      sinceSeconds: opts.sinceSeconds ?? null,
    });

    const offLine = subscribe<{ lines: LogLine[] }>(`log-line:${this.cid}:${streamId}`, (p) => onLines(p.lines));
    const offClosed = subscribe<string>(`log-closed:${this.cid}:${streamId}`, onClosed);

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        offLine();
        offClosed();
        void this.invokeCmd("stop_log_stream", { streamId });
      },
    };
  }

  async saveWorkloadLogs(
    ref: ResourceRef,
    opts: { sinceSeconds?: number },
  ): Promise<SavedLog | null> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "Save logs",
      defaultPath: exportFilename(ref.name, "", false),
      filters: [{ name: "Log", extensions: ["log", "txt"] }],
    });
    if (!path) return null; // cancelled

    const lines = await this.invokeCmd<number>("export_workload_logs", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      sinceSeconds: opts.sinceSeconds ?? null,
      path,
    });
    return { path, lines };
  }

  // ---- shell / exec ----

  async startShell(
    ref: ResourceRef,
    container: string,
    onOutput: (data: string) => void,
    onClosed: (reason: string) => void,
  ): Promise<ShellHandle> {
    const streamId = await this.invokeCmd<string>("start_shell", {
      namespace: ref.namespace ?? "",
      pod: ref.name,
      container,
    });
    const offOut = subscribe<{ data: string }>(`shell-out:${this.cid}:${streamId}`, (p) => onOutput(p.data));
    const offClosed = subscribe<string>(`shell-closed:${this.cid}:${streamId}`, onClosed);

    let stopped = false;
    return {
      input: (data: string) => void this.invokeCmd("shell_input", { streamId, data }),
      resize: (cols: number, rows: number) =>
        void this.invokeCmd("shell_resize", { streamId, cols, rows }),
      stop: () => {
        if (stopped) return;
        stopped = true;
        offOut();
        offClosed();
        void this.invokeCmd("stop_shell", { streamId });
      },
    };
  }

  async startNodeShell(
    node: string,
    onOutput: (data: string) => void,
    onClosed: (reason: string) => void,
  ): Promise<NodeShellHandle> {
    // This call is slow by nature: it creates the pod and waits for the kubelet to
    // start it (image pull included). The backend surfaces *why* it's stuck rather
    // than a bare timeout, so a rejection here is worth showing verbatim.
    const info = await this.invokeCmd<{ streamId: string; namespace: string; pod: string }>(
      "start_node_shell",
      { node },
    );

    const offOut = subscribe<{ data: string }>(`shell-out:${info.streamId}`, (p) =>
      onOutput(p.data),
    );
    const offClosed = subscribe<string>(`shell-closed:${info.streamId}`, onClosed);

    let stopped = false;
    return {
      namespace: info.namespace,
      pod: info.pod,
      input: (data: string) => void this.invokeCmd("shell_input", { streamId: info.streamId, data }),
      resize: (cols: number, rows: number) =>
        void this.invokeCmd("shell_resize", { streamId: info.streamId, cols, rows }),
      stop: () => {
        if (stopped) return;
        stopped = true;
        offOut();
        offClosed();
        // stop_node_shell, not stop_shell: this one also deletes the privileged
        // pod. Leaving that to the generic stop would strand it on the node.
        void this.invokeCmd("stop_node_shell", { streamId: info.streamId, pod: info.pod });
      },
    };
  }

  // ---- port-forwarding ----

  startPortForward(ref: ResourceRef, remotePort: number): Promise<ForwardInfo> {
    // Services need a backing pod resolved first, so they take a different
    // command; `remotePort` is the service port there, not the pod's (B16).
    if (ref.kind === "services") {
      return this.invokeCmd<ForwardInfo>("start_service_port_forward", {
        namespace: ref.namespace ?? "",
        service: ref.name,
        remotePort,
      });
    }
    return this.invokeCmd<ForwardInfo>("start_port_forward", {
      namespace: ref.namespace ?? "",
      pod: ref.name,
      remotePort,
    });
  }

  onForwards(cb: (cid: string, forwards: ForwardInfo[]) => void): Unsub {
    return this.subscribeCluster<ForwardInfo[]>("forwards-update", cb);
  }

  stopPortForward(id: string): Promise<void> {
    return this.invokeCmd<void>("stop_port_forward", { id });
  }

  listPortForwards(): Promise<ForwardInfo[]> {
    return this.invokeCmd<ForwardInfo[]>("list_port_forwards");
  }
}
