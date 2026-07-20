/**
 * Mock properties documents (B13, B18) for demo mode.
 *
 * Mirrors the section shape the Rust gatherers emit (see
 * src-tauri/src/kube/properties.rs) so the Properties tab can be exercised for
 * every supported kind without a cluster.
 */

import type { Cell, Field, KindId, Properties, ResourceRef, Section, Tone } from "../types";
import { MOCK_HELM, MOCK_PODS } from "./data";

/** A plain secondary cell. */
const c = (text: string, tone: Tone = "secondary"): Cell => ({ text, tone });
/** A name cell (primary emphasis, first column of every table). */
const n = (text: string): Cell => ({ text, tone: "primary" });
/** An age cell: an RFC3339 timestamp the UI formats. */
const age = (iso: string): Cell => ({ text: iso, tone: "muted", format: "age" });
/** A field row. */
const f = (label: string, value: string, tone: Tone = "secondary"): Field => ({
  label,
  value: c(value, tone),
});
/** A cell that links to another object (B41), mirroring the Rust gatherers. */
const link = (
  text: string,
  kind: KindId,
  name: string,
  namespace?: string,
  tone: Tone = "secondary",
): Cell => ({ text, tone, nav: { kind, namespace, name } });

const table = (title: string, columns: string[], rows: Cell[][], emptyNote?: string): Section => ({
  title,
  emptyNote,
  body: { type: "table", columns, rows },
});
const fields = (title: string, list: Field[]): Section => ({
  title,
  body: { type: "fields", fields: list },
});
const chips = (title: string, kv: [string, string][]): Section => ({
  title,
  body: { type: "chips", chips: kv.map(([key, value]) => ({ key, value })) },
});

/** An ISO timestamp `daysAgo` days in the past, for age cells. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Build a mock properties document for a kind, or null for kinds without a
 * gatherer (matching the backend, which errors for those).
 */
export function mockProperties(ref: ResourceRef): Properties | null {
  switch (ref.kind) {
    case "pods":
      return podProperties(ref);
    case "deployments":
      return deploymentProperties(ref);
    case "services":
      return serviceProperties(ref);
    case "statefulsets":
      return statefulSetProperties(ref);
    case "nodes":
      return nodeProperties(ref);
    case "helm":
      return helmProperties(ref);
    case "ingresses":
      return ingressProperties(ref);
    default:
      return null;
  }
}

/**
 * Mock Ingress detail (B43): what it routes and where to. Includes a rule whose
 * backend Service doesn't exist — an Ingress pointing at a missing Service is
 * one of the most common ways this breaks, and it's what a 503 looks like.
 */
function ingressProperties(ref: ResourceRef): Properties {
  const ns = ref.namespace;
  return {
    sections: [
      fields("Overview", [
        { label: "class", value: c("traefik"), nav: { kind: "ingressclasses", name: "traefik" } },
        f("default backend", "—"),
        f("address", "192.168.1.156"),
      ]),
      table(
        "Rules",
        ["HOST", "PATH", "PATH TYPE", "SERVICE", "PORT"],
        [
          [
            n(`${ref.name}.freya.io`),
            c("/"),
            c("Prefix"),
            link(ref.name, "services", ref.name, ns),
            // A named port, not a number — the case a number-only reading drops.
            c("http"),
          ],
          [
            n(`${ref.name}.freya.io`),
            c("/api"),
            c("Prefix"),
            c(`${ref.name}-api (not found)`, "warn"),
            c("8080"),
          ],
        ],
        "no rules — this Ingress routes nothing",
      ),
      table(
        "TLS",
        ["HOSTS", "SECRET"],
        [[n(`${ref.name}.freya.io`), link(`${ref.name}-tls`, "secrets", `${ref.name}-tls`, ns)]],
        "no TLS — served over HTTP",
      ),
      chips("Labels", [["app", ref.name]]),
    ],
  };
}

/** Tone for a Helm release status, matching the backend's status_tone. */
function helmTone(status: string): Tone {
  if (status === "deployed") return "ok";
  if (status === "failed") return "err";
  if (status === "superseded" || status === "uninstalled") return "muted";
  return "warn";
}

/**
 * Mock Helm release detail (B35): Overview, a synthetic revision History counting
 * down from the current revision, and Values. Releases matching valkyrie/heimdall
 * carry overrides — including a redacted `dbPassword` to show the redaction — the
 * rest run on chart defaults.
 */
function helmProperties(ref: ResourceRef): Properties {
  const rel = MOCK_HELM.find(([name, ns]) => name === ref.name && ns === ref.namespace);
  const [name, , chart, appVersion, revision, status] =
    rel ?? [ref.name, ref.namespace ?? "", "unknown-0.0.0", "—", 1, "deployed"];

  const desc = status === "failed" ? "Upgrade \"redis\" failed" : "Upgrade complete";

  // History: the current revision, then superseded predecessors down to v1
  // (capped at the last 5, as Helm keeps ten but shows recent ones first).
  const history: Cell[][] = [];
  for (let rev = revision; rev >= 1 && revision - rev < 5; rev--) {
    const st = rev === revision ? status : "superseded";
    history.push([
      n(String(rev)),
      { text: st, tone: helmTone(st), dot: true },
      c(chart),
      c(rev === revision ? desc : "Upgrade complete"),
      age(daysAgo((revision - rev) * 3 + 1)),
    ]);
  }

  const overridden = /valkyrie|heimdall/.test(name);
  const values: Cell[][] = overridden
    ? [
        [n("dbPassword"), c("<redacted>")],
        [n("image.tag"), c(appVersion)],
        [n("replicaCount"), c("2")],
        [n("resources.limits.cpu"), c("500m")],
      ]
    : [];

  return {
    sections: [
      fields("Overview", [
        f("chart", chart),
        f("app version", appVersion),
        f("status", status, helmTone(status)),
        f("revision", String(revision)),
        { label: "first deployed", value: age(daysAgo(31)) },
        { label: "last deployed", value: age(daysAgo(revision > 1 ? 1 : 31)) },
        f("description", desc),
      ]),
      table(
        "History",
        ["REVISION", "STATUS", "CHART", "DESCRIPTION", "UPDATED"],
        history,
        "no revisions",
      ),
      table("Values", ["KEY", "VALUE"], values, "chart defaults (no overrides)"),
    ],
  };
}

function podProperties(ref: ResourceRef): Properties {
  const pod = MOCK_PODS.find((p) => p.name === ref.name);
  const running = pod?.status === "Running";
  const app = ref.name.split("-").slice(0, 2).join("-");
  // Stateful mock pods get a PVC-backed volume so the Storage section is shown.
  const stateful = /db|postgres|prometheus/.test(ref.name);

  const containers = (pod?.containers ?? ["app"]).map((name, i) => {
    const restarts = i === 0 ? (pod?.restarts ?? 0) : 0;
    const state = running ? "Running" : `Waiting: ${pod?.status ?? "Unknown"}`;
    return [
      n(name),
      c(`registry.freya.io/${name}:v2.4.1`),
      c(state, running ? "ok" : "warn"),
      c(running ? "yes" : "no", running ? "ok" : "warn"),
      c(String(restarts), restarts > 5 ? "err" : "secondary"),
      c("100m / 1"),
      c("256Mi / 1Gi"),
      c("8080/TCP"),
    ];
  });

  return {
    sections: [
      fields("Overview", [
        { label: "node", value: c(pod?.node ?? "—"), nav: { kind: "nodes", name: pod?.node ?? "" } },
        f("pod IP", "10.244.2.37"),
        f("host IP", "192.168.1.153"),
        f("QoS", "Burstable"),
        // Owner resolves through the ReplicaSet to its workload, with a nav target
        // that makes it a click-through link (B33). Which workload depends on the
        // pod: a `-<ordinal>` pod belongs to a StatefulSet, and pointing every pod
        // at a Deployment would link to one the demo data doesn't have.
        {
          label: "owner",
          value: c(stateful ? `StatefulSet/${app}` : `Deployment/${app}`),
          nav: {
            kind: stateful ? "statefulsets" : "deployments",
            namespace: ref.namespace,
            name: app,
          },
        },
        f("service account", `${ref.namespace}-runtime`),
        f("restart policy", "Always"),
        f("priority class", "—"),
        { label: "started", value: age(daysAgo(4)) },
      ]),
      table(
        "Containers",
        ["NAME", "IMAGE", "STATE", "READY", "RESTARTS", "CPU R/L", "MEM R/L", "PORTS"],
        containers,
        "no containers",
      ),
      table(
        "Storage",
        ["VOLUME", "CLAIM", "PV", "CAPACITY", "CLASS", "ACCESS", "PHASE", "MOUNTED AT"],
        stateful
          ? [
              [
                n("data"),
                // Claim, volume and class all link through (B41).
                link(`data-${ref.name}`, "persistentvolumeclaims", `data-${ref.name}`, ref.namespace),
                link("pvc-8f2c1a3e-4b7d-11ef-9c21", "persistentvolumes", "pvc-8f2c1a3e-4b7d-11ef-9c21"),
                c("20Gi"),
                link("local-path", "storageclasses", "local-path"),
                c("ReadWriteOnce"),
                c("Bound", "ok"),
                c("/var/lib/data"),
              ],
            ]
          : [],
        "no persistent volumes attached",
      ),
      table(
        "Services",
        ["NAME", "TYPE", "CLUSTER-IP", "PORTS"],
        [[link(app, "services", app, ref.namespace, "primary"), c("ClusterIP"), c("10.96.14.22"), c("8080/TCP")]],
        "no services select this pod",
      ),
      table(
        "Other volumes",
        ["VOLUME", "KIND", "SOURCE", "MOUNTED AT"],
        [
          [
            n("config"),
            c("ConfigMap"),
            link(`${app}-config`, "configmaps", `${app}-config`, ref.namespace),
            c("/etc/config (ro)"),
          ],
          // An optional source that doesn't exist: the mount is empty, which is
          // worth saying rather than linking to a 404 (B41).
          [n("tls"), c("Secret"), c(`${app}-tls (not found)`, "warn"), c("/etc/tls (ro)")],
          [
            n("kube-api-access"),
            c("Projected"),
            c("—"),
            c("/var/run/secrets/kubernetes.io/serviceaccount (ro)"),
          ],
        ],
      ),
      chips("Labels", [
        ["app", app],
        ["version", "v2.4.1"],
        ["team", "platform"],
      ]),
      chips("Annotations", [
        ["prometheus.io/scrape", "true"],
        ["prometheus.io/port", "9090"],
      ]),
    ],
  };
}

function deploymentProperties(ref: ResourceRef): Properties {
  // Mirror the mock deployments table: heimdall-auth is the degraded one.
  const degraded = /heimdall|canary/.test(ref.name);
  const desired = 2;
  const ready = degraded ? 0 : 2;
  return {
    sections: [
      fields("Overview", [
        f("replicas", `${ready}/${desired} ready`, degraded ? "err" : "ok"),
        f("up-to-date", String(desired)),
        f("available", String(ready)),
        f("unavailable", String(desired - ready), degraded ? "warn" : "secondary"),
        f("strategy", "RollingUpdate (max surge 25%, max unavailable 25%)"),
        f("selector", `app=${ref.name}`),
        f("generation", "7"),
        f("paused", "no"),
      ]),
      table(
        "ReplicaSets",
        ["NAME", "REVISION", "DESIRED", "CURRENT", "READY", "AGE"],
        [
          [
            n(`${ref.name}-6c8d9`),
            c("7"),
            c(String(desired)),
            c(String(desired)),
            c(String(ready), degraded ? "err" : "ok"),
            age(daysAgo(4)),
          ],
          [n(`${ref.name}-7d9f8`), c("6"), c("0"), c("0"), c("0", "muted"), age(daysAgo(11))],
        ],
        "no replica sets (or none readable)",
      ),
      table(
        "Conditions",
        ["TYPE", "STATUS", "REASON", "MESSAGE", "SINCE"],
        degraded
          ? [
              [
                n("Available"),
                c("False", "err"),
                c("MinimumReplicasUnavailable"),
                c("Deployment does not have minimum availability."),
                age(daysAgo(0.09)),
              ],
              [
                n("Progressing"),
                c("False", "err"),
                c("ProgressDeadlineExceeded"),
                c(`ReplicaSet "${ref.name}-6c8d9" has timed out progressing.`),
                age(daysAgo(0.05)),
              ],
            ]
          : [
              [
                n("Available"),
                c("True", "ok"),
                c("MinimumReplicasAvailable"),
                c("Deployment has minimum availability."),
                age(daysAgo(4)),
              ],
              [
                n("Progressing"),
                c("True", "ok"),
                c("NewReplicaSetAvailable"),
                c(`ReplicaSet "${ref.name}-6c8d9" has successfully progressed.`),
                age(daysAgo(4)),
              ],
            ],
        "no conditions reported",
      ),
      chips("Labels", [["app", ref.name]]),
    ],
  };
}

function serviceProperties(ref: ResourceRef): Properties {
  return {
    sections: [
      fields("Overview", [
        f("type", "ClusterIP"),
        f("cluster IP", "10.96.14.22"),
        f("load balancer", "—"),
        f("external IPs", "—"),
        f("selector", `app=${ref.name}`),
        f("session affinity", "None"),
        f("traffic policy", "—"),
      ]),
      table(
        "Ports",
        ["NAME", "PORT", "TARGET", "NODE PORT", "PROTOCOL"],
        [[n("http"), c("8080"), c("http"), c("—"), c("TCP")]],
        "no ports",
      ),
      table(
        "Endpoints",
        ["ADDRESS", "READY", "POD", "NODE"],
        [
          [n("10.244.2.37"), c("ready", "ok"), c(`${ref.name}-6c8d9-mn4p`), c("freya-node-02")],
          [n("10.244.3.14"), c("ready", "ok"), c(`${ref.name}-6c8d9-qq7z`), c("freya-node-03")],
        ],
        "no endpoints — nothing is backing this service",
      ),
      chips("Labels", [["app", ref.name]]),
    ],
  };
}

function statefulSetProperties(ref: ResourceRef): Properties {
  return {
    sections: [
      fields("Overview", [
        f("replicas", "2/2 ready", "ok"),
        f("current", "2"),
        f("updated", "2"),
        f("service name", `${ref.name}-headless`),
        f("update strategy", "RollingUpdate"),
        f("pod management", "OrderedReady"),
        f("selector", `app=${ref.name}`),
        f("current revision", `${ref.name}-5f7c8d9b64`),
      ]),
      table(
        "Volume claim templates",
        ["NAME", "CLASS", "ACCESS", "REQUEST"],
        [[n("data"), c("local-path"), c("ReadWriteOnce"), c("20Gi")]],
      ),
      table(
        "Persistent volume claims",
        ["NAME", "PHASE", "CAPACITY", "CLASS", "PV", "AGE"],
        [0, 1].map((i) => [
          n(`data-${ref.name}-${i}`),
          c("Bound", "ok"),
          c("20Gi"),
          c("local-path"),
          c(`pvc-8f2c1a3e-4b7d-11ef-9c2${i}`),
          age(daysAgo(31)),
        ]),
        "no claims yet",
      ),
      table("Conditions", ["TYPE", "STATUS", "REASON", "MESSAGE", "SINCE"], [], "no conditions reported"),
      chips("Labels", [["app", ref.name]]),
    ],
  };
}

function nodeProperties(ref: ResourceRef): Properties {
  const control = ref.name.endsWith("01");
  return {
    sections: [
      fields("Overview", [
        f("schedulable", "yes", "ok"),
        f("kubelet", "v1.31.2"),
        f("runtime", "containerd://1.7.22"),
        f("OS image", "Ubuntu 24.04.1 LTS"),
        f("kernel", "6.8.0-45-generic"),
        f("architecture", "arm64"),
        f("pod CIDR", "10.244.2.0/24"),
        f("provider", "—"),
      ]),
      table(
        "Capacity",
        ["RESOURCE", "CAPACITY", "ALLOCATABLE"],
        [
          [n("cpu"), c("8"), c("7910m")],
          [n("ephemeral-storage"), c("468Gi"), c("431Gi")],
          [n("memory"), c("16Gi"), c("15.2Gi")],
          [n("pods"), c("110"), c("110")],
        ],
        "not reported",
      ),
      table(
        "Conditions",
        ["TYPE", "STATUS", "REASON", "MESSAGE", "SINCE"],
        [
          [n("Ready"), c("True", "ok"), c("KubeletReady"), c("kubelet is posting ready status"), age(daysAgo(31))],
          [n("MemoryPressure"), c("False", "ok"), c("KubeletHasSufficientMemory"), c("kubelet has sufficient memory available"), age(daysAgo(31))],
          [n("DiskPressure"), c("False", "ok"), c("KubeletHasNoDiskPressure"), c("kubelet has no disk pressure"), age(daysAgo(31))],
          [n("PIDPressure"), c("False", "ok"), c("KubeletHasSufficientPID"), c("kubelet has sufficient PID available"), age(daysAgo(31))],
        ],
        "no conditions reported",
      ),
      table(
        "Taints",
        ["KEY", "VALUE", "EFFECT"],
        control
          ? [[n("node-role.kubernetes.io/control-plane"), c("—"), c("NoSchedule", "warn")]]
          : [],
        "no taints",
      ),
      table(
        "Addresses",
        ["TYPE", "ADDRESS"],
        [
          [n("InternalIP"), c("192.168.50.4")],
          [n("Hostname"), c(ref.name)],
        ],
        "no addresses",
      ),
      chips("Labels", [
        ["kubernetes.io/arch", "arm64"],
        ["kubernetes.io/hostname", ref.name],
        ...(control ? ([["node-role.kubernetes.io/control-plane", ""]] as [string, string][]) : []),
      ]),
    ],
  };
}
