/**
 * Pod Metrics tab: live CPU and memory usage for one pod, summed across its
 * containers, read from the same `metrics.k8s.io` feed that drives the pod list.
 *
 * Live-only, like a node's Metrics tab (B27): the series starts empty and fills as
 * the metrics poller ticks (~15s by default). There's no per-pod history to
 * backfill — metrics-server keeps none — so the first point appears on the first
 * poll and the chart grows from there. Sampling runs only while this tab is
 * mounted; see usePodStats.
 */

import { useRef } from "react";
import styles from "./PodMetricsTab.module.css";
import { useStore } from "../../store";
import { usePodStats } from "../../hooks/usePodStats";
import { humanBytes, plotColors } from "./plot";
import { Plot, useHostPlotColors } from "./PlotChart";
import { withAlpha } from "../../lib/theme";
import type { PodSample } from "../../providers/types";

export function PodMetricsTab() {
  const row = useStore((s) => s.selectedRow);
  const key = row?.namespace ? `${row.namespace}/${row.name}` : undefined;
  const samples = useStore((s) => (key ? (s.podSamples[key] ?? EMPTY) : EMPTY));
  const wrapRef = useRef<HTMLDivElement>(null);
  const PLOT_COLORS = useHostPlotColors(wrapRef);

  // Forward this pod's samples while the tab is open, and only while it's open.
  usePodStats(key);

  if (!key) return null;

  // metrics-server serves usage directly (not a counter), so a point lands on the
  // first poll — but that's still up to one interval away. Say so rather than
  // showing an empty chart that looks broken.
  if (samples.length === 0) {
    return (
      <div className={styles.wrap} ref={wrapRef}>
        <div className={styles.state}>
          <div className={styles.stateTitle}>waiting for the first samples…</div>
          <div className={styles.stateBody}>
            Usage is polled on an interval, so the first point takes a few seconds to arrive. If it
            never does, this cluster likely has no metrics-server — the pod list would show CPU and
            memory as “—” too.
          </div>
        </div>
      </div>
    );
  }

  const t = samples.map((s) => new Date(s.ts));
  const latest = samples[samples.length - 1];
  const res = row?.pod?.resources;

  // Request/limit reference lines. The y axis is stretched to include whichever
  // is highest so "how much headroom is left" is the shape you read — even when
  // usage sits far below the limit.
  const cpuRefs: RefLine[] = [
    { value: res?.cpuRequestMillis ?? null, label: (v) => `req ${humanCpu(v)}`, kind: "request" },
    { value: res?.cpuLimitMillis ?? null, label: (v) => `limit ${humanCpu(v)}`, kind: "limit" },
  ];
  const memRefs: RefLine[] = [
    { value: res?.memRequestBytes ?? null, label: (v) => `req ${humanBytes(v)}`, kind: "request" },
    { value: res?.memLimitBytes ?? null, label: (v) => `limit ${humanBytes(v)}`, kind: "limit" },
  ];
  const cpuMax = Math.max(0, ...samples.map((s) => s.cpuMillis));
  const memMax = Math.max(0, ...samples.map((s) => s.memBytes));

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <Plot
        title={`CPU — ${humanCpu(latest.cpuMillis)}${refSuffix(res?.cpuRequestMillis, res?.cpuLimitMillis, humanCpu)}`}
        data={[
          {
            x: t,
            y: samples.map((s) => s.cpuMillis),
            type: "scatter",
            mode: "lines",
            line: { color: PLOT_COLORS.accent, width: 1.5, shape: "spline", smoothing: 0.4 },
            fill: "tozeroy",
            fillcolor: withAlpha(PLOT_COLORS.accent, 0.12),
            hovertemplate: "%{y} m<extra></extra>",
          },
        ]}
        // Millicores, floored at zero — a pod's usage has no fixed ceiling the way
        // a node's percentage does, so the axis tracks the data (and any limit).
        layoutExtra={{
          yaxis: { ...axisRange(cpuMax, cpuRefs), ticksuffix: " m", gridcolor: PLOT_COLORS.grid },
          ...refShapes(cpuRefs, PLOT_COLORS),
        }}
      />

      <Plot
        title={`Memory — ${humanBytes(latest.memBytes)}${refSuffix(res?.memRequestBytes, res?.memLimitBytes, humanBytes)}`}
        data={[
          {
            x: t,
            y: samples.map((s) => s.memBytes),
            type: "scatter",
            mode: "lines",
            line: { color: PLOT_COLORS.ok, width: 1.5 },
            fill: "tozeroy",
            fillcolor: withAlpha(PLOT_COLORS.ok, 0.12),
            hovertemplate: "%{y:.3s}B<extra></extra>",
          },
        ]}
        layoutExtra={{
          yaxis: { ...axisRange(memMax, memRefs), tickformat: ".3s", ticksuffix: "B", gridcolor: PLOT_COLORS.grid },
          ...refShapes(memRefs, PLOT_COLORS),
        }}
      />
    </div>
  );
}

/** A request/limit reference line; `label` formats its own value for the tag. */
interface RefLine {
  value: number | null;
  label: (v: number) => string;
  kind: "request" | "limit";
}

/**
 * Plotly `shapes` + `annotations` for the reference lines that are set. A limit
 * is a hard ceiling, so it's drawn boldest (dashed, warn-coloured); a request is
 * a softer marker (dotted, muted).
 */
function refShapes(refs: RefLine[], colors: ReturnType<typeof plotColors>) {
  const shapes = [];
  const annotations = [];
  for (const r of refs) {
    if (r.value == null) continue;
    const color = r.kind === "limit" ? colors.warn : colors.axis;
    shapes.push({
      type: "line",
      xref: "paper",
      x0: 0,
      x1: 1,
      yref: "y",
      y0: r.value,
      y1: r.value,
      line: { color, width: 1, dash: r.kind === "limit" ? "dash" : "dot" },
    });
    annotations.push({
      xref: "paper",
      x: 1,
      xanchor: "right",
      y: r.value,
      yref: "y",
      yanchor: "bottom",
      text: r.label(r.value),
      showarrow: false,
      font: { size: 9, color },
      bgcolor: withAlpha(colors.surface, 0.65),
    });
  }
  return { shapes, annotations };
}

/**
 * Y-axis bounds that include the highest reference line, with a little headroom,
 * so a limit far above current usage stays visible. Falls back to plotly's own
 * data-driven scale (from zero) when nothing is set.
 */
function axisRange(usageMax: number, refs: RefLine[]): Record<string, unknown> {
  const top = Math.max(usageMax, ...refs.map((r) => r.value ?? 0));
  return top > 0 ? { range: [0, top * 1.15] } : { rangemode: "tozero" };
}

/** CPU as a short human string: millicores, or cores once it's past a full one. */
function humanCpu(millis: number): string {
  return millis >= 1000 ? `${(millis / 1000).toFixed(2)} cores` : `${millis}m`;
}

/** " · req X / limit Y" for the chart title, omitting either part when unset. */
function refSuffix(
  request: number | null | undefined,
  limit: number | null | undefined,
  fmt: (v: number) => string,
): string {
  const parts: string[] = [];
  if (request != null) parts.push(`req ${fmt(request)}`);
  if (limit != null) parts.push(`limit ${fmt(limit)}`);
  return parts.length ? `  ·  ${parts.join(" / ")}` : "";
}

/** Stable empty array so the selector doesn't churn renders. */
const EMPTY: PodSample[] = [];
