/**
 * Mock YAML generator — ported from the prototype's `yamlFor(pod)`. Produces a
 * plausible Pod manifest for the YAML tab in demo mode.
 */

import { MOCK_PODS, type MockPod } from "./data";

/** Generate the YAML text for a pod, matching the prototype's template. */
export function yamlForPod(pod: MockPod): string {
  const appLabel = pod.name.split("-").slice(0, 2).join("-");
  const containers = pod.containers
    .map(
      (c) => `    - name: ${c}
      image: registry.freya.io/${c}:v2.4.1
      ports:
        - containerPort: 8080
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          cpu: "1"
          memory: 1Gi
      readinessProbe:
        httpGet:
          path: /healthz
          port: 8080
        periodSeconds: 10`,
    )
    .join("\n");

  // podIP is randomized like the prototype so the value looks live.
  const podIp = `10.244.${Math.floor(Math.random() * 5) + 1}.${Math.floor(Math.random() * 200) + 10}`;

  return `apiVersion: v1
kind: Pod
metadata:
  name: ${pod.name}
  namespace: ${pod.ns}
  labels:
    app: ${appLabel}
    version: v2.4.1
    team: platform
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9090"
spec:
  nodeName: ${pod.node}
  serviceAccountName: ${pod.ns}-runtime
  containers:
${containers}
  restartPolicy: Always
status:
  phase: ${pod.status === "Running" ? "Running" : pod.status}
  podIP: ${podIp}
  qosClass: Burstable`;
}

/** Look up a pod by name and generate its YAML, or "" if not found. */
export function yamlForPodName(name: string | null): string {
  const pod = MOCK_PODS.find((p) => p.name === name);
  return pod ? yamlForPod(pod) : "";
}

/** Singular Kind name for a resource-kind id (best-effort, for the mock stub). */
function kindName(kind: string): string {
  const map: Record<string, string> = {
    deployments: "Deployment",
    statefulsets: "StatefulSet",
    daemonsets: "DaemonSet",
    jobs: "Job",
    cronjobs: "CronJob",
    services: "Service",
    ingresses: "Ingress",
    configmaps: "ConfigMap",
    secrets: "Secret",
    nodes: "Node",
    namespaces: "Namespace",
  };
  return map[kind] ?? "Resource";
}

/**
 * A generic YAML stub for non-pod kinds in demo mode, so the YAML tab has content
 * to show. Secrets get redacted values to mirror the real backend's behavior.
 */
export function yamlForGeneric(kind: string, namespace: string | undefined, name: string): string {
  const meta = namespace
    ? `metadata:\n  name: ${name}\n  namespace: ${namespace}`
    : `metadata:\n  name: ${name}`;
  const body =
    kind === "secrets"
      ? `type: Opaque\ndata:\n  username: "<redacted>"\n  password: "<redacted>"`
      : `spec:\n  # (demo stub — real clusters return the full manifest)\n  selector:\n    app: ${name}`;
  return `apiVersion: v1\nkind: ${kindName(kind)}\n${meta}\n  labels:\n    app: ${name}\n${body}`;
}
