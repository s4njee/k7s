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
