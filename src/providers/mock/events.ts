/**
 * Mock events generator — ported from the prototype's events logic. A
 * CrashLoopBackOff pod gets Warning BackOff/Unhealthy events; healthy pods get the
 * Normal Scheduled/Pulled/Started sequence.
 */

import type { EventItem } from "../types";
import { MOCK_PODS } from "./data";

/** Build the events list for a pod by name (empty if not found). */
export function eventsForPodName(name: string | null): EventItem[] {
  const pod = MOCK_PODS.find((p) => p.name === name);
  if (!pod) return [];

  const containers = pod.containers;

  if (pod.status === "CrashLoopBackOff") {
    return [
      { type: "Warning", reason: "BackOff", age: "2m", count: 14, message: `Back-off restarting failed container heimdall-auth in pod ${pod.name}` },
      { type: "Warning", reason: "Unhealthy", age: "3m", count: 9, message: "Liveness probe failed: HTTP probe failed with statuscode: 503" },
      { type: "Normal", reason: "Pulled", age: "2h", count: 1, message: 'Container image "registry.freya.io/heimdall-auth:v2.4.1" already present on machine' },
      { type: "Normal", reason: "Scheduled", age: "2h", count: 1, message: `Successfully assigned prod/${pod.name} to ${pod.node}` },
    ];
  }

  return [
    { type: "Normal", reason: "Started", age: pod.age, count: 1, message: `Started container ${containers[0]}` },
    { type: "Normal", reason: "Pulled", age: pod.age, count: 1, message: `Container image "registry.freya.io/${containers[0]}:v2.4.1" already present on machine` },
    { type: "Normal", reason: "Scheduled", age: pod.age, count: 1, message: `Successfully assigned ${pod.ns}/${pod.name} to ${pod.node}` },
  ];
}
