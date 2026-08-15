/**
 * Layered layout for the topology graph (B55): a left-to-right DAG via
 * longest-path layering — a node sits one layer past its deepest parent, so the
 * Deployment → ReplicaSet → Pod chain flows left to right. No graph library:
 * the neighborhood is small (≤16 nodes), so a plain layout is plenty.
 */

import type { TopologyEdge, TopologyNode } from "../providers/types";

export interface LayoutNode extends TopologyNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NODE_W = 150;
const NODE_H = 34;
const COL_GAP = 90;
const ROW_GAP = 18;
const PAD = 20;

/** The canvas dimensions the layout needs. */
export function graphSize(nodes: LayoutNode[]): { width: number; height: number } {
  if (nodes.length === 0) {
    return { width: 320, height: 160 };
  }
  const w = Math.max(...nodes.map((n) => n.x + n.w)) + PAD;
  const h = Math.max(...nodes.map((n) => n.y + n.h)) + PAD;
  return { width: Math.max(w, 320), height: Math.max(h, 160) };
}

/** Assign left-to-right positions to the nodes. Deterministic, so the graph is
 *  stable across re-renders (and the layout is testable). */
export function layoutGraph(nodes: TopologyNode[], edges: TopologyEdge[]): LayoutNode[] {
  // Longest-path layering: a node's layer is one past its deepest parent;
  // nodes with no incoming edges (Deployment, Ingress) sit at layer 0.
  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const e of edges) incoming.get(e.to)?.push(e.from);

  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  const compute = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // Break cycle
    visiting.add(id);

    const parents = incoming.get(id) ?? [];
    const l = parents.length ? Math.max(...parents.map(compute)) + 1 : 0;

    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const n of nodes) compute(n.id);

  // Bucket by layer, preserving node order so the layout doesn't shuffle.
  const byLayer = new Map<number, TopologyNode[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    const bucket = byLayer.get(l);
    if (bucket) bucket.push(n);
    else byLayer.set(l, [n]);
  }

  const out: LayoutNode[] = [];
  for (const [l, layerNodes] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const x = PAD + l * (NODE_W + COL_GAP);
    let y = PAD;
    for (const n of layerNodes) {
      out.push({ ...n, x, y, w: NODE_W, h: NODE_H });
      y += NODE_H + ROW_GAP;
    }
  }
  return out;
}
