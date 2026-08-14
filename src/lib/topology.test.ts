/**
 * Tests for the topology layout (B55): longest-path layering turns the
 * ownership/reference graph into a left-to-right DAG — the Deployment →
 * ReplicaSet → Pods chain flows right, and references don't cross it.
 */

import { describe, expect, it } from "vitest";
import { graphSize, layoutGraph } from "./topology";
import type { TopologyEdge, TopologyNode } from "../providers/types";

const N = (id: string, kind: string, name: string, nav: string): TopologyNode => ({
  id,
  kind,
  namespace: "prod",
  name,
  nav: nav as TopologyNode["nav"],
});

/** The backlog's accept graph: a Deployment with its RS + pods, and a Service
 *  + Ingress referencing the pods via selector / backend. */
const NODES = [
  N("deployments:prod/api", "Deployment", "api", "deployments"),
  N("replicasets:prod/api-6c8d9", "ReplicaSet", "api-6c8d9", "replicasets"),
  N("pods:prod/api-6c8d9-mn4p", "Pod", "api-6c8d9-mn4p", "pods"),
  N("pods:prod/api-6c8d9-qq7z", "Pod", "api-6c8d9-qq7z", "pods"),
  N("services:prod/api", "Service", "api", "services"),
  N("ingresses:prod/api-public", "Ingress", "api-public", "ingresses"),
];
const EDGES: TopologyEdge[] = [
  { from: "deployments:prod/api", to: "replicasets:prod/api-6c8d9", rel: "ownership" },
  { from: "replicasets:prod/api-6c8d9", to: "pods:prod/api-6c8d9-mn4p", rel: "ownership" },
  { from: "replicasets:prod/api-6c8d9", to: "pods:prod/api-6c8d9-qq7z", rel: "ownership" },
  { from: "services:prod/api", to: "pods:prod/api-6c8d9-mn4p", rel: "reference" },
  { from: "services:prod/api", to: "pods:prod/api-6c8d9-qq7z", rel: "reference" },
  { from: "ingresses:prod/api-public", to: "services:prod/api", rel: "reference" },
];

describe("layoutGraph (B55)", () => {
  it("flows ownership left to right: Deployment → ReplicaSet → Pods", () => {
    const layout = layoutGraph(NODES, EDGES);
    const byId = new Map(layout.map((n) => [n.id, n]));
    const dep = byId.get("deployments:prod/api")!;
    const rs = byId.get("replicasets:prod/api-6c8d9")!;
    const pod = byId.get("pods:prod/api-6c8d9-mn4p")!;
    expect(rs.x).toBeGreaterThan(dep.x);
    expect(pod.x).toBeGreaterThan(rs.x);
  });

  it("lays roots at the left and places every node without overlap", () => {
    const layout = layoutGraph(NODES, EDGES);
    // Roots (Deployment, Ingress) are the leftmost layer.
    const dep = layout.find((n) => n.id === "deployments:prod/api")!;
    const ing = layout.find((n) => n.id === "ingresses:prod/api-public")!;
    expect(dep.x).toBe(ing.x);
    const leftmost = Math.min(...layout.map((n) => n.x));
    expect(dep.x).toBe(leftmost);
    // No two nodes overlap.
    for (let i = 0; i < layout.length; i++) {
      for (let j = i + 1; j < layout.length; j++) {
        const a = layout[i];
        const b = layout[j];
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap, `${a.name} vs ${b.name}`).toBe(false);
      }
    }
  });

  it("places the seed's pods in a later layer than the Service that references them", () => {
    // The Service references the pods, so it must be *before* them in the DAG —
    // otherwise the reference would flow backwards.
    const layout = layoutGraph(NODES, EDGES);
    const svc = layout.find((n) => n.id === "services:prod/api")!;
    const pod = layout.find((n) => n.id === "pods:prod/api-6c8d9-qq7z")!;
    expect(pod.x).toBeGreaterThan(svc.x);
  });

  it("sizes the canvas to the laid-out content", () => {
    const layout = layoutGraph(NODES, EDGES);
    const size = graphSize(layout);
    expect(size.width).toBeGreaterThanOrEqual(320);
    expect(size.height).toBeGreaterThanOrEqual(160);
  });
});
