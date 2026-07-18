/**
 * Mock resource data — ported verbatim from the design prototype
 * (design/K8s Monitor.dc.html, `class Component`). This drives demo mode so the
 * whole UI can be pixel-compared against the prototype with identical data.
 *
 * The raw records mirror the prototype's `pods` getter and `resourceDefs`. The
 * `build*Rows` functions convert them into the provider's Row/Cell shape, applying
 * the prototype's exact per-cell coloring (tone) and status-dot rules.
 */

import type { Cell, CustomKind, Row, PodMeta, Tone } from "../types";
import { KIND_META, type ResourceKind } from "../../lib/kinds";
import { parseCpuMillis, parseMemBytes } from "../../lib/format";

/** Raw pod record, matching the prototype's pod objects. */
export interface MockPod {
  name: string;
  ns: string;
  ready: string;
  restarts: number;
  cpu: string;
  mem: string;
  age: string;
  status: string;
  node: string;
  containers: string[];
}

/** The 13 pods from the prototype, verbatim (order preserved). */
export const MOCK_PODS: MockPod[] = [
  { name: "valkyrie-api-7d9f8b64d-x2k4n", ns: "prod", ready: "3/3", restarts: 0, cpu: "212m", mem: "486Mi", age: "4d2h", status: "Running", node: "freya-node-02", containers: ["valkyrie-api", "istio-proxy", "log-shipper"] },
  { name: "valkyrie-api-7d9f8b64d-p9w7z", ns: "prod", ready: "3/3", restarts: 0, cpu: "198m", mem: "471Mi", age: "4d2h", status: "Running", node: "freya-node-04", containers: ["valkyrie-api", "istio-proxy", "log-shipper"] },
  { name: "bifrost-gateway-5c7dd4f6b-jl2mn", ns: "prod", ready: "2/2", restarts: 1, cpu: "341m", mem: "812Mi", age: "11d", status: "Running", node: "freya-node-01", containers: ["bifrost-gateway", "istio-proxy"] },
  { name: "yggdrasil-db-0", ns: "prod", ready: "1/1", restarts: 0, cpu: "890m", mem: "3.2Gi", age: "31d", status: "Running", node: "freya-node-03", containers: ["postgres"] },
  { name: "yggdrasil-db-1", ns: "prod", ready: "1/1", restarts: 0, cpu: "124m", mem: "2.9Gi", age: "31d", status: "Running", node: "freya-node-05", containers: ["postgres"] },
  { name: "heimdall-auth-6b8c9d5f7-qq3rt", ns: "prod", ready: "1/2", restarts: 14, cpu: "45m", mem: "203Mi", age: "2h14m", status: "CrashLoopBackOff", node: "freya-node-02", containers: ["heimdall-auth", "istio-proxy"] },
  { name: "mimir-cache-7f4b8c6d9-ab8cd", ns: "prod", ready: "1/1", restarts: 0, cpu: "67m", mem: "1.1Gi", age: "11d", status: "Running", node: "freya-node-04", containers: ["redis"] },
  { name: "valkyrie-api-canary-89f7c5d4b-nn2kp", ns: "staging", ready: "0/3", restarts: 0, cpu: "—", mem: "—", age: "38s", status: "Pending", node: "—", containers: ["valkyrie-api", "istio-proxy", "log-shipper"] },
  { name: "loki-runner-6d9f7b8c5-tt4vw", ns: "staging", ready: "1/1", restarts: 2, cpu: "88m", mem: "340Mi", age: "3d", status: "Running", node: "freya-node-06", containers: ["loki-runner"] },
  { name: "prometheus-server-0", ns: "monitoring", ready: "2/2", restarts: 0, cpu: "512m", mem: "2.4Gi", age: "31d", status: "Running", node: "freya-node-01", containers: ["prometheus", "config-reloader"] },
  { name: "grafana-5f8d7c6b9-mm1xz", ns: "monitoring", ready: "1/1", restarts: 0, cpu: "34m", mem: "187Mi", age: "31d", status: "Running", node: "freya-node-06", containers: ["grafana"] },
  { name: "coredns-76f75df574-8rk2j", ns: "kube-system", ready: "1/1", restarts: 0, cpu: "12m", mem: "31Mi", age: "31d", status: "Running", node: "freya-node-01", containers: ["coredns"] },
  { name: "kube-proxy-x9d4m", ns: "kube-system", ready: "1/1", restarts: 0, cpu: "8m", mem: "24Mi", age: "31d", status: "Running", node: "freya-node-02", containers: ["kube-proxy"] },
];

/** Namespaces offered in the namespace dropdown (prototype order). */
export const MOCK_NAMESPACES = ["all", "prod", "staging", "monitoring", "kube-system"];

/** Cluster switcher entries (prototype's `clusterDefs`). */
export const MOCK_CLUSTERS = [
  { name: "freya", env: "prod", active: true },
  { name: "odin-staging", env: "staging", active: false },
  { name: "loki-dev", env: "dev", active: false },
];

/**
 * Raw non-pod resource rows, matching the prototype's `resourceDefs`.
 * `c` is the ordered list of cell values *after* the name/namespace columns.
 * `ns` is "" for cluster-scoped kinds. `ok` marks a healthy first data cell
 * (renders green with a dot); `warn` marks a degraded row (0-prefixed cells amber).
 */
interface RawRow {
  name: string;
  ns: string;
  c: string[];
  ok?: boolean;
  warn?: boolean;
}

const R = (name: string, ns: string, c: string[], flags: { ok?: boolean; warn?: boolean } = {}): RawRow => ({ name, ns, c, ...flags });

/** Non-pod resource data keyed by kind (verbatim from the prototype). */
export const MOCK_RESOURCES: Partial<Record<ResourceKind, RawRow[]>> = {
  deployments: [
    R("valkyrie-api", "prod", ["2/2", "2", "2", "4d2h"]),
    R("bifrost-gateway", "prod", ["1/1", "1", "1", "11d"]),
    R("heimdall-auth", "prod", ["0/1", "1", "0", "2h14m"], { warn: true }),
    R("mimir-cache", "prod", ["1/1", "1", "1", "11d"]),
    R("valkyrie-api-canary", "staging", ["0/1", "1", "0", "38s"], { warn: true }),
    R("grafana", "monitoring", ["1/1", "1", "1", "31d"]),
  ],
  statefulsets: [
    R("yggdrasil-db", "prod", ["2/2", "31d"]),
    R("prometheus-server", "monitoring", ["1/1", "31d"]),
  ],
  daemonsets: [
    R("kube-proxy", "kube-system", ["6", "6", "31d"]),
    R("node-exporter", "monitoring", ["6", "6", "31d"]),
    R("fluent-bit", "monitoring", ["6", "6", "18d"]),
  ],
  jobs: [
    R("db-migrate-v214", "prod", ["1/1", "42s", "4d2h"]),
    R("report-gen-28661", "prod", ["1/1", "3m12s", "6h"]),
  ],
  cronjobs: [
    R("report-gen", "prod", ["0 */6 * * *", "6h ago", "31d"]),
    R("cache-warm", "prod", ["*/15 * * * *", "4m ago", "11d"]),
  ],
  services: [
    R("valkyrie-api", "prod", ["ClusterIP", "10.96.14.22", "8080/TCP", "31d"]),
    R("bifrost-gateway", "prod", ["LoadBalancer", "10.96.8.101", "443/TCP", "31d"]),
    R("yggdrasil-db", "prod", ["ClusterIP", "None", "5432/TCP", "31d"]),
    R("grafana", "monitoring", ["ClusterIP", "10.96.31.7", "3000/TCP", "31d"]),
  ],
  ingresses: [
    R("api-public", "prod", ["api.freya.io", "nginx", "31d"]),
    R("grafana", "monitoring", ["grafana.freya.internal", "nginx", "31d"]),
  ],
  configmaps: [
    R("valkyrie-api-config", "prod", ["9", "4d2h"]),
    R("bifrost-routes", "prod", ["14", "11d"]),
    R("coredns", "kube-system", ["1", "31d"]),
  ],
  secrets: [
    R("yggdrasil-db-creds", "prod", ["Opaque", "3", "31d"]),
    R("tls-api-freya-io", "prod", ["kubernetes.io/tls", "2", "12d"]),
    R("registry-pull", "prod", ["dockerconfigjson", "1", "31d"]),
  ],
  nodes: [
    R("freya-node-01", "", ["Ready", "control-plane", "38%", "61%", "v1.31.2"], { ok: true }),
    R("freya-node-02", "", ["Ready", "worker", "52%", "74%", "v1.31.2"], { ok: true }),
    R("freya-node-03", "", ["Ready", "worker", "71%", "82%", "v1.31.2"], { ok: true }),
    R("freya-node-04", "", ["Ready", "worker", "44%", "58%", "v1.31.2"], { ok: true }),
    R("freya-node-05", "", ["Ready", "worker", "29%", "66%", "v1.31.2"], { ok: true }),
    R("freya-node-06", "", ["Ready", "worker", "12%", "39%", "v1.31.2"], { ok: true }),
  ],
  namespaces: [
    R("prod", "", ["Active", "7", "31d"], { ok: true }),
    R("staging", "", ["Active", "2", "31d"], { ok: true }),
    R("monitoring", "", ["Active", "2", "31d"], { ok: true }),
    R("kube-system", "", ["Active", "2", "31d"], { ok: true }),
    R("default", "", ["Active", "0", "31d"], { ok: true }),
  ],
};

/** The prototype's status→color rule, expressed as a tone. */
export function statusTone(status: string): Tone {
  if (status === "Running" || status === "Ready" || status === "Active") return "ok";
  if (status === "Pending") return "warn";
  return "err";
}

/** Build the Pods table rows with the prototype's exact per-cell coloring. */
export function buildPodRows(): Row[] {
  return stressPods(MOCK_PODS).map((p) => {
    // READY "a/b" is amber when not all containers are ready (a===0 or a!==b).
    const readyDegraded = p.ready[0] === "0" || p.ready[0] !== p.ready[2];
    const meta: PodMeta = {
      node: p.node,
      containers: p.containers,
      status: p.status,
      ready: p.ready,
      restarts: p.restarts,
      creationTs: p.age, // demo mode shows the literal age; no live ISO needed
      statusTone: statusTone(p.status),
    };
    const cells: Cell[] = [
      { text: p.name, tone: "primary" },
      { text: p.ns, tone: "muted" },
      { text: p.ready, tone: readyDegraded ? "warn" : "secondary" },
      { text: String(p.restarts), tone: p.restarts > 5 ? "err" : "secondary" },
      // CPU/MEM carry numeric sort keys since their units aren't lexical.
      { text: p.cpu, tone: "secondary", sort: parseCpuMillis(p.cpu) },
      { text: p.mem, tone: "secondary", sort: parseMemBytes(p.mem) },
      { text: p.age, tone: "muted" },
      { text: p.status, tone: statusTone(p.status), dot: true },
    ];
    return {
      uid: `pod:${p.ns}/${p.name}`,
      name: p.name,
      namespace: p.ns,
      cells,
      pod: meta,
      // A conventional app label so the "view pods" selector jump (B33) resolves
      // in demo mode: derived from the pod name the way the workload's would be.
      labels: { app: deriveApp(p.name) },
    };
  });
}

/**
 * The app a pod belongs to, from its name: strip a Deployment's
 * "<rs-hash>-<pod-hash>" or a StatefulSet's "-<ordinal>" suffix. Demo-only, so a
 * workload's `app=<name>` selector matches its pods' `app` label.
 */
function deriveApp(name: string): string {
  return name.replace(/-[a-z0-9]{5,10}-[a-z0-9]{4,5}$/, "").replace(/-\d+$/, "");
}

/**
 * The demo events feed (B14), already in the order the real backend emits:
 * Warnings first, then newest. Mirrors the warnings the mock pods imply
 * (heimdall-auth crash-looping, the canary unschedulable).
 */
const MOCK_EVENTS: {
  type: "Warning" | "Normal";
  reason: string;
  object: string;
  ns: string;
  age: string;
  count: number;
  message: string;
}[] = [
  { type: "Warning", reason: "BackOff", object: "Pod/heimdall-auth-7d9f4-x2k1", ns: "prod", age: "12s", count: 41, message: "Back-off restarting failed container auth in pod heimdall-auth-7d9f4-x2k1" },
  { type: "Warning", reason: "FailedScheduling", object: "Pod/valkyrie-api-canary-5b8-qq7z", ns: "staging", age: "38s", count: 9, message: "0/6 nodes are available: 6 Insufficient memory. preemption: 0/6 nodes are available." },
  { type: "Warning", reason: "Unhealthy", object: "Pod/heimdall-auth-7d9f4-x2k1", ns: "prod", age: "1m", count: 23, message: "Readiness probe failed: HTTP probe failed with statuscode: 503" },
  { type: "Warning", reason: "FailedMount", object: "Pod/report-gen-28661-lx4d", ns: "prod", age: "6h", count: 2, message: "MountVolume.SetUp failed for volume \"reports\": timed out waiting for the condition" },
  { type: "Normal", reason: "Scheduled", object: "Pod/valkyrie-api-6c8d9-mn4p", ns: "prod", age: "4m", count: 1, message: "Successfully assigned prod/valkyrie-api-6c8d9-mn4p to freya-node-02" },
  { type: "Normal", reason: "Pulled", object: "Pod/valkyrie-api-6c8d9-mn4p", ns: "prod", age: "4m", count: 1, message: "Container image \"registry.freya.io/valkyrie-api:2.14.0\" already present on machine" },
  { type: "Normal", reason: "Created", object: "Pod/valkyrie-api-6c8d9-mn4p", ns: "prod", age: "4m", count: 1, message: "Created container api" },
  { type: "Normal", reason: "Started", object: "Pod/valkyrie-api-6c8d9-mn4p", ns: "prod", age: "4m", count: 1, message: "Started container api" },
  { type: "Normal", reason: "SuccessfulCreate", object: "Job/report-gen-28661", ns: "prod", age: "6h", count: 1, message: "Created pod: report-gen-28661-lx4d" },
  { type: "Normal", reason: "ScalingReplicaSet", object: "Deployment/valkyrie-api", ns: "prod", age: "4d2h", count: 1, message: "Scaled up replica set valkyrie-api-6c8d9 to 2" },
];

/** Build the demo events feed. Events have no NAME column, so they skip the generic builder. */
function buildEventRows(): Row[] {
  return MOCK_EVENTS.map((e, i) => {
    const [kind, name] = e.object.split("/");
    return {
      // Synthetic id in the shape k8s uses for event names.
      uid: `event:${e.ns}/${e.object}.${i}`,
      name: `${name}.17c3f${i}`,
      namespace: e.ns,
      cells: [
        { text: e.type, tone: e.type === "Warning" ? "err" : "ok" },
        { text: e.reason, tone: "primary" },
        { text: e.object, tone: "secondary" },
        { text: e.ns, tone: "muted" },
        { text: e.age, tone: "muted" },
        { text: `×${e.count}`, tone: "secondary" },
        { text: e.message, tone: "secondary" },
      ],
      // The object the event is about, for click-through (B33).
      involved: { kind, name, namespace: e.ns },
    };
  });
}

// ---------------------------------------------------------------------------
// Custom (CRD-backed) kinds — B15
// ---------------------------------------------------------------------------

/**
 * Demo CRDs, chosen to mirror what a real cluster looks like: a namespaced kind,
 * a second one from the same group, and a cluster-scoped one (no NAMESPACE column).
 */
export const MOCK_CUSTOM_KINDS: CustomKind[] = [
  {
    id: "argoproj.io/applications",
    group: "argoproj.io",
    version: "v1alpha1",
    kind: "Application",
    plural: "applications",
    namespaced: true,
  },
  {
    id: "argoproj.io/appprojects",
    group: "argoproj.io",
    version: "v1alpha1",
    kind: "AppProject",
    plural: "appprojects",
    namespaced: true,
  },
  {
    id: "traefik.io/ingressroutes",
    group: "traefik.io",
    version: "v1alpha1",
    kind: "IngressRoute",
    plural: "ingressroutes",
    namespaced: true,
  },
  {
    id: "cert-manager.io/clusterissuers",
    group: "cert-manager.io",
    version: "v1",
    kind: "ClusterIssuer",
    plural: "clusterissuers",
    namespaced: false,
  },
];

/** Demo objects per custom kind id: [name, namespace ("" = cluster-scoped), age]. */
const MOCK_CUSTOM_ROWS: Record<string, [string, string, string][]> = {
  "argoproj.io/applications": [
    ["valkyrie", "argocd", "31d"],
    ["bifrost", "argocd", "31d"],
    ["observability", "argocd", "18d"],
  ],
  "argoproj.io/appprojects": [["default", "argocd", "31d"]],
  "traefik.io/ingressroutes": [
    ["api-public", "prod", "12d"],
    ["grafana", "monitoring", "31d"],
  ],
  "cert-manager.io/clusterissuers": [
    ["letsencrypt-prod", "", "31d"],
    ["letsencrypt-staging", "", "31d"],
  ],
};

/**
 * Build rows for a custom kind. Columns are the generic NAME, NAMESPACE?, AGE —
 * the same set the backend's `map_dynamic` emits.
 */
export function buildCustomRows(id: string): Row[] {
  const ck = MOCK_CUSTOM_KINDS.find((k) => k.id === id);
  const raw = MOCK_CUSTOM_ROWS[id] ?? [];
  return raw.map(([name, ns, age]) => {
    const cells: Cell[] = [{ text: name, tone: "primary" }];
    if (ck?.namespaced) cells.push({ text: ns, tone: "muted" });
    cells.push({ text: age, tone: "muted" });
    return { uid: `${id}:${ns}/${name}`, name, namespace: ns === "" ? undefined : ns, cells };
  });
}

/**
 * Table-virtualization fixture (B21): with `VITE_STRESS=<n>` set, pad the pod list
 * out to n synthetic pods so the windowed path can actually be scrolled and
 * measured. There's no honest way to check a 5k-row table stays smooth without a
 * 5k-row table. Off by default, and demo-only.
 */
function stressPods(pods: MockPod[]): MockPod[] {
  const want = Number(import.meta.env.VITE_STRESS ?? 0);
  if (!Number.isFinite(want) || want <= pods.length) return pods;

  const out = pods.slice();
  // Cycle the real pods so the synthetic rows keep a realistic spread of
  // statuses, restart counts and name lengths (which is what column layout and
  // tone rendering actually cost).
  for (let i = pods.length; i < want; i++) {
    const base = pods[i % pods.length];
    out.push({ ...base, name: `${base.name}-${String(i).padStart(5, "0")}` });
  }
  return out;
}

/**
 * Demo Helm releases (B26). Column order matches the backend's `map_release`:
 * NAME, NAMESPACE, CHART, APP VERSION, REVISION, STATUS, UPDATED.
 *
 * Includes a `failed` and a `pending-upgrade` release: the statuses worth seeing
 * are the ones that aren't `deployed`.
 */
export const MOCK_HELM: [string, string, string, string, number, string, string][] = [
  ["traefik", "kube-system", "traefik-27.0.2", "v3.0.0", 3, "deployed", "31d"],
  ["prometheus", "monitoring", "kube-prometheus-stack-58.2.1", "v0.73.2", 7, "deployed", "18d"],
  ["grafana", "monitoring", "grafana-7.3.9", "10.4.1", 2, "deployed", "31d"],
  ["valkyrie", "prod", "valkyrie-1.4.0", "2.14.0", 12, "pending-upgrade", "4m"],
  ["heimdall", "prod", "heimdall-0.9.1", "1.2.0", 5, "failed", "2h14m"],
];

/** Build rows for the demo Helm releases. */
function buildHelmRows(): Row[] {
  const tone = (s: string): Tone =>
    s === "deployed" ? "ok" : s === "failed" ? "err" : s === "superseded" ? "muted" : "warn";
  return MOCK_HELM.map(([name, ns, chart, appVersion, revision, status, updated]) => ({
    uid: `helm:${ns}/${name}`,
    name,
    namespace: ns,
    cells: [
      { text: name, tone: "primary" },
      { text: ns, tone: "muted" },
      { text: chart, tone: "secondary" },
      { text: appVersion, tone: "secondary" },
      { text: String(revision), tone: "secondary", sort: revision },
      { text: status, tone: tone(status), dot: true },
      { text: updated, tone: "muted" },
    ],
  }));
}

// ---------------------------------------------------------------------------
// Storage: PersistentVolumeClaims and PersistentVolumes
// ---------------------------------------------------------------------------

/** Tone for a claim/volume phase, matching the backend's pvc_tone / pv_tone. */
function storageTone(phase: string): Tone {
  if (phase === "Bound") return "ok";
  if (phase === "Available") return "secondary";
  if (phase === "Lost" || phase === "Failed") return "err";
  return "warn"; // Pending / Released
}

/** [name, ns, status, volume, capacity, access, class, age] */
const MOCK_PVCS: [string, string, string, string, string, string, string, string][] = [
  ["valkyrie-data", "prod", "Bound", "pvc-0bc73481-5d44-439d", "20Gi", "RWO", "local-path", "31d"],
  ["heimdall-data", "prod", "Bound", "pvc-1063061a-160c-401b", "5Gi", "RWO", "local-path", "31d"],
  ["prometheus-data", "monitoring", "Bound", "pvc-a3269fdf-6ec2-4a07", "50Gi", "RWO", "local-path", "18d"],
  // The claim a StatefulSet pod mounts, so the pod → CLAIM → PV chain in the
  // Properties panel lands on rows that actually exist in demo mode.
  ["data-yggdrasil-db-0", "prod", "Bound", "pvc-8f2c1a3e-4b7d-11ef-9c21", "20Gi", "RWO", "local-path", "31d"],
  ["grafana-data", "monitoring", "Bound", "pvc-c23b8f6e-6b7e-4707", "1Gi", "RWO", "local-path", "18d"],
  // The case worth seeing: a claim that never bound, so it has no volume and
  // shows what it *asked* for rather than an empty capacity.
  ["reports-archive", "prod", "Pending", "—", "100Gi", "RWX", "nfs-slow", "13d"],
];

/** [name, capacity, access, reclaim, status, claim, class, age] */
const MOCK_PVS: [string, string, string, string, string, string, string, string][] = [
  ["pvc-0bc73481-5d44-439d", "20Gi", "RWO", "Delete", "Bound", "prod/valkyrie-data", "local-path", "31d"],
  ["pvc-1063061a-160c-401b", "5Gi", "RWO", "Delete", "Bound", "prod/heimdall-data", "local-path", "31d"],
  ["pvc-a3269fdf-6ec2-4a07", "50Gi", "RWO", "Delete", "Bound", "monitoring/prometheus-data", "local-path", "18d"],
  ["pvc-8f2c1a3e-4b7d-11ef-9c21", "20Gi", "RWO", "Delete", "Bound", "prod/data-yggdrasil-db-0", "local-path", "31d"],
  ["pvc-c23b8f6e-6b7e-4707", "1Gi", "RWO", "Delete", "Bound", "monitoring/grafana-data", "local-path", "18d"],
  // An unclaimed volume sitting idle, and one whose claim was deleted but whose
  // data is still on disk — the two non-Bound states that matter.
  ["pv-spare-ssd-01", "200Gi", "RWO", "Retain", "Available", "—", "fast-ssd", "62d"],
  ["pv-archive-2025", "500Gi", "RWX", "Retain", "Released", "prod/old-archive", "nfs-slow", "180d"],
];

/** [name, controller, parameters, age] */
const MOCK_INGRESSCLASSES: [string, string, string, string][] = [
  ["traefik (default)", "traefik.io/ingress-controller", "—", "62d"],
  ["nginx", "k8s.io/ingress-nginx", "IngressParameters/nginx-tuning", "48d"],
];

function buildIngressClassRows(): Row[] {
  return MOCK_INGRESSCLASSES.map(([name, controller, parameters, age]) => ({
    // The "(default)" marker is display only; the object's name is the bare one.
    uid: `ic:${name}`,
    name: name.replace(" (default)", ""),
    cells: [
      { text: name, tone: "primary" },
      { text: controller, tone: "secondary" },
      { text: parameters, tone: "secondary" },
      { text: age, tone: "muted" },
    ],
  }));
}

/** [name, ns, secrets, age] — one with a hand-attached token, the case worth
 * seeing, since modern clusters mint none automatically. */
const MOCK_SERVICEACCOUNTS: [string, string, number, string][] = [
  ["default", "prod", 0, "62d"],
  ["prod-runtime", "prod", 0, "31d"],
  ["legacy-ci", "prod", 1, "410d"],
  ["default", "staging", 0, "62d"],
  ["default", "monitoring", 0, "62d"],
  ["prometheus", "monitoring", 0, "31d"],
];

function buildServiceAccountRows(): Row[] {
  return MOCK_SERVICEACCOUNTS.map(([name, ns, secrets, age]) => ({
    uid: `sa:${ns}/${name}`,
    name,
    namespace: ns,
    cells: [
      { text: name, tone: "primary" },
      { text: ns, tone: "muted" },
      // Non-zero means a long-lived token was attached by hand.
      { text: String(secrets), tone: secrets > 0 ? "warn" : "secondary" },
      { text: age, tone: "muted" },
    ],
  }));
}

/** [name, provisioner, reclaim, binding, expansion, age] */
const MOCK_STORAGECLASSES: [string, string, string, string, string, string][] = [
  ["local-path (default)", "rancher.io/local-path", "Delete", "WaitForFirstConsumer", "false", "62d"],
  ["fast-ssd", "csi.example.io/nvme", "Delete", "Immediate", "true", "62d"],
  ["nfs-slow", "nfs.csi.k8s.io", "Retain", "Immediate", "true", "48d"],
];

function buildStorageClassRows(): Row[] {
  return MOCK_STORAGECLASSES.map(([name, provisioner, reclaim, binding, expansion, age]) => ({
    // The "(default)" marker is display only; the object's name is the bare one.
    uid: `sc:${name}`,
    name: name.replace(" (default)", ""),
    cells: [
      { text: name, tone: "primary" },
      { text: provisioner, tone: "secondary" },
      { text: reclaim, tone: "secondary" },
      { text: binding, tone: "secondary" },
      { text: expansion, tone: "secondary" },
      { text: age, tone: "muted" },
    ],
  }));
}

/** [name, ns, desired, current, ready, age] — one live generation per workload
 * plus a scaled-down predecessor, which is what a ReplicaSets list mostly is. */
const MOCK_REPLICASETS: [string, string, number, number, number, string][] = [
  ["valkyrie-api-6c8d9", "prod", 2, 2, 2, "4d2h"],
  ["valkyrie-api-5b7f2", "prod", 0, 0, 0, "9d"],
  ["heimdall-auth-7d9f4", "prod", 1, 1, 0, "31d"],
  ["yggdrasil-web-84c6b", "staging", 3, 3, 3, "12d"],
  ["yggdrasil-web-79a41", "staging", 0, 0, 0, "18d"],
];

function buildReplicaSetRows(): Row[] {
  return MOCK_REPLICASETS.map(([name, ns, desired, current, ready, age]) => ({
    uid: `rs:${ns}/${name}`,
    name,
    namespace: ns,
    cells: [
      { text: name, tone: "primary" },
      { text: ns, tone: "muted" },
      // A superseded generation (0 desired) is history, not a fault.
      { text: String(desired), tone: desired === 0 ? "muted" : "secondary" },
      { text: String(current), tone: "secondary" },
      {
        text: String(ready),
        tone: desired === 0 ? "muted" : ready !== desired ? "warn" : "secondary",
      },
      { text: age, tone: "muted" },
    ],
  }));
}

function buildPvcRows(): Row[] {
  return MOCK_PVCS.map(([name, ns, status, volume, capacity, access, cls, age]) => ({
    uid: `pvc:${ns}/${name}`,
    name,
    namespace: ns,
    cells: [
      { text: name, tone: "primary" },
      { text: ns, tone: "muted" },
      { text: status, tone: storageTone(status), dot: true },
      { text: volume, tone: "secondary" },
      { text: capacity, tone: "secondary" },
      { text: access, tone: "secondary" },
      { text: cls, tone: "secondary" },
      { text: age, tone: "muted" },
    ],
  }));
}

function buildPvRows(): Row[] {
  return MOCK_PVS.map(([name, capacity, access, reclaim, status, claim, cls, age]) => ({
    uid: `pv:${name}`,
    name,
    // Cluster-scoped: no namespace, so the namespace filter ignores these.
    cells: [
      { text: name, tone: "primary" },
      { text: capacity, tone: "secondary" },
      { text: access, tone: "secondary" },
      { text: reclaim, tone: "secondary" },
      { text: status, tone: storageTone(status), dot: true },
      { text: claim, tone: "secondary" },
      { text: cls, tone: "secondary" },
      { text: age, tone: "muted" },
    ],
  }));
}

/** Build rows for a non-pod kind from MOCK_RESOURCES with the prototype's coloring. */
export function buildKindRows(kind: ResourceKind): Row[] {
  if (kind === "pods") return buildPodRows();
  if (kind === "events") return buildEventRows();
  if (kind === "helm") return buildHelmRows();
  if (kind === "persistentvolumeclaims") return buildPvcRows();
  if (kind === "persistentvolumes") return buildPvRows();
  if (kind === "storageclasses") return buildStorageClassRows();
  if (kind === "serviceaccounts") return buildServiceAccountRows();
  if (kind === "ingressclasses") return buildIngressClassRows();
  if (kind === "replicasets") return buildReplicaSetRows();
  const raw = MOCK_RESOURCES[kind] ?? [];
  const hasNamespaceCol = KIND_META[kind].columns[1] === "NAMESPACE";

  return raw.map((r) => {
    const cells: Cell[] = [{ text: r.name, tone: "primary" }];
    if (hasNamespaceCol) cells.push({ text: r.ns, tone: "muted" });

    r.c.forEach((v, i) => {
      // Healthy first data cell → green with a leading dot (e.g. node "● Ready").
      if (r.ok && i === 0) {
        cells.push({ text: v, tone: "ok", dot: true });
      } else if (r.warn && v[0] === "0") {
        // Degraded numeric cell (e.g. deployment "0/1") → amber.
        cells.push({ text: v, tone: "warn" });
      } else {
        cells.push({ text: v, tone: "secondary" });
      }
    });

    const isWorkload =
      kind === "deployments" || kind === "statefulsets" || kind === "daemonsets";
    return {
      uid: `${kind}:${r.ns}/${r.name}`,
      name: r.name,
      namespace: r.ns === "" ? undefined : r.ns,
      cells,
      // Workloads select their pods by the conventional app label (B33).
      ...(isWorkload ? { selector: { app: r.name } } : {}),
    };
  });
}
