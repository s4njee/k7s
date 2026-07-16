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
import type {
  ClusterInfo,
  ClusterStatus,
  ContextInfo,
  DataProvider,
  EventItem,
  LogHandle,
  LogLine,
  LogOptions,
  NodeMetricsMap,
  PodMetricsMap,
  Prefs,
  ResourceKind,
  ResourceRef,
  Row,
  Unsub,
} from "../types";

/** Wire payload for the `resource-update` event. */
interface ResourceUpdatePayload {
  kind: ResourceKind;
  rows: Row[];
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
  // ---- one-shot commands ----

  listContexts(): Promise<ContextInfo[]> {
    return invoke<ContextInfo[]>("list_contexts");
  }

  connect(context: string): Promise<ClusterInfo> {
    return invoke<ClusterInfo>("connect", { context });
  }

  async importKubeconfig(): Promise<ContextInfo[] | null> {
    // Lazy-import the dialog plugin so it isn't pulled into demo bundles.
    const { open } = await import("@tauri-apps/plugin-dialog");
    // Pre-point the dialog at kubectl's default kubeconfig for one-click import.
    const defaultPath = await invoke<string>("default_kubeconfig_path");
    const selected = await open({
      title: "Import kubeconfig",
      multiple: false,
      directory: false,
      defaultPath: defaultPath || undefined,
    });
    // User cancelled, or (defensively) a multi-selection came back.
    if (!selected || Array.isArray(selected)) return null;
    return invoke<ContextInfo[]>("import_kubeconfig", { path: selected });
  }

  getYaml(ref: ResourceRef): Promise<string> {
    return invoke<string>("get_yaml", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  applyYaml(ref: ResourceRef, text: string): Promise<void> {
    return invoke<void>("apply_yaml", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      yaml: text,
    });
  }

  getEvents(ref: ResourceRef): Promise<EventItem[]> {
    return invoke<EventItem[]>("get_events", {
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  deleteResource(ref: ResourceRef): Promise<void> {
    return invoke<void>("delete_resource", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
    });
  }

  scaleResource(ref: ResourceRef, replicas: number): Promise<void> {
    return invoke<void>("scale_resource", {
      kind: ref.kind,
      namespace: ref.namespace ?? "",
      name: ref.name,
      replicas,
    });
  }

  setCordon(node: string, unschedulable: boolean): Promise<void> {
    return invoke<void>("set_cordon", { name: node, unschedulable });
  }

  loadPrefs(): Promise<Prefs | null> {
    return invoke<Prefs | null>("load_prefs");
  }

  savePrefs(prefs: Prefs): Promise<void> {
    return invoke<void>("save_prefs", { prefs });
  }

  // ---- push subscriptions ----

  onResourceUpdate(cb: (kind: ResourceKind, rows: Row[]) => void): Unsub {
    return subscribe<ResourceUpdatePayload>("resource-update", (p) => cb(p.kind, p.rows));
  }

  onPodMetrics(cb: (metrics: PodMetricsMap) => void): Unsub {
    return subscribe<PodMetricsMap>("pod-metrics", cb);
  }

  onNodeMetrics(cb: (metrics: NodeMetricsMap) => void): Unsub {
    return subscribe<NodeMetricsMap>("node-metrics", cb);
  }

  onClusterStatus(cb: (status: ClusterStatus) => void): Unsub {
    return subscribe<ClusterStatus>("cluster-status", cb);
  }

  onWatchStatus(cb: (activeStreams: number) => void): Unsub {
    return subscribe<number>("watch-status", cb);
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
    const streamId = await invoke<string>("start_log_stream", {
      namespace: ref.namespace ?? "",
      pod: ref.name,
      container,
      tail: opts.tail ?? null,
      sinceTime: opts.sinceTime ?? null,
    });

    const offLine = subscribe<{ lines: LogLine[] }>(`log-line:${streamId}`, (p) => onLines(p.lines));
    const offClosed = subscribe<string>(`log-closed:${streamId}`, onClosed);

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        offLine();
        offClosed();
        // Fire-and-forget: cancel the backend task.
        void invoke("stop_log_stream", { streamId });
      },
    };
  }
}
