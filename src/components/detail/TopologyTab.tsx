/**
 * Topology tab (B55): the ownership/reference graph around the selected
 * resource, drawn on a <canvas> — nodes are rounded rects with the kind and a
 * short name, ownership edges are solid, references are dashed. A simple
 * left-to-right layered layout places the graph; clicking a node navigates to
 * it. Colours come from the live design tokens, so both themes render correctly.
 */

import { useEffect, useRef, useState } from "react";
import styles from "./TopologyTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useResolvedTheme } from "../../hooks/useTheme";
import { layoutGraph, graphSize, type LayoutNode } from "../../lib/topology";
import { plotColors } from "../../lib/theme";
import type { Topology, TopologyEdge } from "../../providers/types";

const FONT = "10px 'JetBrains Mono', ui-monospace, monospace";

export function TopologyTab() {
  const row = useStore((s) => s.selectedRow);
  const kind = useStore((s) => s.nav);
  const navigateTo = useStore((s) => s.navigateTo);
  const theme = useResolvedTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [topo, setTopo] = useState<Topology | null>(null);
  const [error, setError] = useState<string | null>(null);
  const layoutRef = useRef<LayoutNode[]>([]);

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setTopo(null);
    setError(null);
    void getProvider()
      .getTopology({ kind, namespace: row.namespace, name: row.name })
      .then((t) => {
        if (!cancelled) setTopo(t);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [row?.uid, row?.namespace, row?.name, kind]);

  // Lay out and draw whenever the graph or the theme changes.
  useEffect(() => {
    if (!topo) return;
    const layout = layoutGraph(topo.nodes, topo.edges);
    layoutRef.current = layout;
    const size = graphSize(layout);
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawGraph(canvas, layout, topo.edges, size.width, size.height, topo.nodes[0]?.id);
  }, [topo, theme]);

  if (!row) return null;
  if (error) return <div className={styles.state}>{error}</div>;
  if (!topo) return <div className={styles.state}>loading topology…</div>;

  return (
    <div className={styles.wrap}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onClick={(e) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          for (const n of layoutRef.current) {
            if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) {
              navigateTo({ kind: n.nav, namespace: n.namespace || undefined, name: n.name });
              return;
            }
          }
        }}
      />
    </div>
  );
}

/** The short form of a name for a node: the pod hash suffix, else the name. */
function shortName(name: string): string {
  const i = name.lastIndexOf("-");
  return i === -1 || name.length - i > 8 ? name : name.slice(i + 1);
}

/** Draw the graph at 1:1 CSS pixels (with device-pixel-ratio crispness). */
function drawGraph(
  canvas: HTMLCanvasElement,
  layout: LayoutNode[],
  edges: TopologyEdge[],
  width: number,
  height: number,
  seedId: string | undefined,
) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const colors = plotColors(canvas);
  const byId = new Map(layout.map((n) => [n.id, n]));

  // Edges: a horizontal line from the source's right edge to the target's left,
  // dashed for references (selector/backend) and solid for ownership.
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    ctx.strokeStyle = e.rel === "reference" ? colors.grid : colors.axis;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(e.rel === "reference" ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(from.x + from.w, from.y + from.h / 2);
    ctx.lineTo(to.x, to.y + to.h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Nodes: rounded rects; the seed is highlighted with the accent.
  for (const n of layout) {
    const isSeed = n.id === seedId;
    ctx.fillStyle = isSeed ? colors.accent2 : colors.surface;
    ctx.strokeStyle = isSeed ? colors.accent : colors.grid;
    ctx.lineWidth = isSeed ? 2 : 1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.stroke();

    ctx.font = isSeed ? "600 10px 'JetBrains Mono', ui-monospace, monospace" : FONT;
    ctx.fillStyle = isSeed ? "#0a0a0c" : colors.axis;
    ctx.fillText(n.kind, n.x + 8, n.y + 13);
    ctx.font = FONT;
    ctx.fillStyle = isSeed ? "#121216" : colors.axis;
    ctx.fillText(shortName(n.name), n.x + 8, n.y + 27);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
