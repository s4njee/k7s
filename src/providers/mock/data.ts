/**
 * Mock resource data — ported verbatim from the design prototype
 * (design/K8s Monitor.dc.html, `class Component`). This drives demo mode so the
 * whole UI can be pixel-compared against the prototype with identical data.
 *
 * The raw records mirror the prototype's `pods` getter and `resourceDefs`. The
 * `build*Rows` functions convert them into the provider's Row/Cell shape, applying
 * the prototype's exact per-cell coloring (tone) and status-dot rules.
 */

import type { Cell, Row, PodMeta, Tone } from "../types";
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
  return MOCK_PODS.map((p) => {
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
    return { uid: `pod:${p.ns}/${p.name}`, name: p.name, namespace: p.ns, cells, pod: meta };
  });
}

/** Build rows for a non-pod kind from MOCK_RESOURCES with the prototype's coloring. */
export function buildKindRows(kind: ResourceKind): Row[] {
  if (kind === "pods") return buildPodRows();
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

    return {
      uid: `${kind}:${r.ns}/${r.name}`,
      name: r.name,
      namespace: r.ns === "" ? undefined : r.ns,
      cells,
    };
  });
}
