/**
 * Metrics tab (B27): live CPU / memory / network / load plots for a node, plus
 * current filesystem usage, read from the node's node-exporter.
 *
 * The series is **live-only** and starts empty. That isn't a shortcut: an exporter
 * serves counters ("CPU-seconds since boot"), not history, so there is nothing to
 * backfill from. Prometheus would have history — but only if it's actually
 * scraping the exporters, which can't be assumed (see kube/exporter.rs).
 *
 * Scraping runs only while this tab is mounted; see useNodeStats.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import styles from "./MetricsTab.module.css";
import { useStore } from "../../store";
import { useNodeStats } from "../../hooks/useNodeStats";
import { baseLayout, humanBps, humanBytes, plotColors, PLOT_CONFIG } from "./plot";
import { useResolvedTheme } from "../../hooks/useTheme";
import { withAlpha } from "../../lib/theme";
import type { NodeSample } from "../../providers/types";

/**
 * Plotly colours for the host's token surface. Re-resolves after mount (ref is
 * null on the first render) and whenever the app palette flips — needed so
 * light-mode dark panels don't hand plotly the document's light tokens.
 */
function useHostPlotColors(hostRef: RefObject<Element | null>) {
  const theme = useResolvedTheme();
  const [colors, setColors] = useState(() => plotColors());
  useLayoutEffect(() => {
    setColors(plotColors(hostRef.current));
  }, [hostRef, theme]);
  return colors;
}

export function MetricsTab() {
  const row = useStore((s) => s.selectedRow);
  const node = row?.name;
  const samples = useStore((s) => (node ? (s.nodeSamples[node] ?? EMPTY) : EMPTY));
  const error = useStore((s) => (node ? s.nodeStatsErrors[node] : undefined));
  const wrapRef = useRef<HTMLDivElement>(null);
  const PLOT_COLORS = useHostPlotColors(wrapRef);

  // Scrape while this tab is open, and only while it's open.
  useNodeStats(node);

  if (!node) return null;

  if (error) {
    return (
      <div className={styles.wrap} ref={wrapRef}>
        <div className={styles.state}>
          <div className={styles.stateTitle}>no metrics for {node}</div>
          <div className={styles.stateBody}>{error}</div>
        </div>
      </div>
    );
  }

  // The first scrape only establishes a baseline for the counters, so the first
  // point takes two polls to arrive. Say so, rather than showing an empty chart
  // that looks broken.
  if (samples.length === 0) {
    return (
      <div className={styles.wrap} ref={wrapRef}>
        <div className={styles.state}>
          <div className={styles.stateTitle}>waiting for the first samples…</div>
          <div className={styles.stateBody}>
            Rates need two scrapes to compare, so the first point takes a couple of polls. The
            history starts now — node-exporter reports counters, not the past.
          </div>
        </div>
      </div>
    );
  }

  const t = samples.map((s) => new Date(s.ts));
  const latest = samples[samples.length - 1];

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <Plot
        title={`CPU — ${latest.cpuPercent.toFixed(1)}% busy`}
        data={[
          {
            x: t,
            y: samples.map((s) => s.cpuPercent),
            type: "scatter",
            mode: "lines",
            line: { color: PLOT_COLORS.accent, width: 1.5, shape: "spline", smoothing: 0.4 },
            fill: "tozeroy",
            fillcolor: withAlpha(PLOT_COLORS.accent, 0.12),
            hovertemplate: "%{y:.1f}%<extra></extra>",
          },
        ]}
        // A CPU axis that rescales to the data makes 3% look like a crisis.
        layoutExtra={{ yaxis: { range: [0, 100], ticksuffix: "%", gridcolor: PLOT_COLORS.grid } }}
      />

      <Plot
        title={`Memory — ${humanBytes(latest.memUsedBytes)} of ${humanBytes(latest.memTotalBytes)} (${pct(latest.memUsedBytes, latest.memTotalBytes)})`}
        data={[
          {
            x: t,
            y: samples.map((s) => s.memUsedBytes),
            type: "scatter",
            mode: "lines",
            line: { color: PLOT_COLORS.ok, width: 1.5 },
            fill: "tozeroy",
            fillcolor: withAlpha(PLOT_COLORS.ok, 0.12),
            hovertemplate: "%{y:.3s}B<extra></extra>",
          },
        ]}
        // Against total, so the plot answers "how much room is left".
        layoutExtra={{
          yaxis: {
            range: [0, latest.memTotalBytes],
            tickformat: ".3s",
            ticksuffix: "B",
            gridcolor: PLOT_COLORS.grid,
          },
        }}
      />

      <Plot
        title={`Network — ↓ ${humanBps(latest.netRxBps)}  ↑ ${humanBps(latest.netTxBps)}`}
        data={[
          {
            x: t,
            y: samples.map((s) => s.netRxBps),
            name: "rx",
            type: "scatter",
            mode: "lines",
            line: { color: PLOT_COLORS.accent, width: 1.5 },
            hovertemplate: "↓ %{y:.3s}B/s<extra></extra>",
          },
          {
            x: t,
            y: samples.map((s) => s.netTxBps),
            name: "tx",
            type: "scatter",
            mode: "lines",
            line: { color: PLOT_COLORS.warn, width: 1.5 },
            hovertemplate: "↑ %{y:.3s}B/s<extra></extra>",
          },
        ]}
        layoutExtra={{
          showlegend: true,
          legend: { orientation: "h", y: 1.16, x: 1, xanchor: "right", font: { size: 9 } },
          yaxis: { rangemode: "tozero", tickformat: ".3s", ticksuffix: "B/s", gridcolor: PLOT_COLORS.grid },
        }}
      />

      <Plot
        title={`Load — ${latest.load1.toFixed(2)} / ${latest.load5.toFixed(2)} / ${latest.load15.toFixed(2)}`}
        data={[
          { x: t, y: samples.map((s) => s.load1), name: "1m", type: "scatter", mode: "lines", line: { color: PLOT_COLORS.accent, width: 1.5 } },
          { x: t, y: samples.map((s) => s.load5), name: "5m", type: "scatter", mode: "lines", line: { color: PLOT_COLORS.accent2, width: 1.2 } },
          { x: t, y: samples.map((s) => s.load15), name: "15m", type: "scatter", mode: "lines", line: { color: PLOT_COLORS.axis, width: 1, dash: "dot" } },
        ]}
        layoutExtra={{
          showlegend: true,
          legend: { orientation: "h", y: 1.16, x: 1, xanchor: "right", font: { size: 9 } },
          yaxis: { rangemode: "tozero", gridcolor: PLOT_COLORS.grid },
        }}
      />

      <Filesystems sample={latest} colors={PLOT_COLORS} />
    </div>
  );
}

/** Current filesystem usage as a horizontal bar per mount. */
function Filesystems({
  sample,
  colors: PLOT_COLORS,
}: {
  sample: NodeSample;
  colors: ReturnType<typeof plotColors>;
}) {

  if (sample.filesystems.length === 0) return null;

  // Fullest first: the one about to cause an incident belongs at the top, not
  // wherever the alphabet puts it. Plotly's y axis draws bottom-up, so the array
  // is reversed to put the largest at the top.
  const fs = [...sample.filesystems]
    .map((f) => ({ ...f, pct: (100 * f.usedBytes) / Math.max(f.sizeBytes, 1) }))
    .sort((a, b) => a.pct - b.pct);

  const color = (p: number) =>
    p >= 90 ? PLOT_COLORS.err : p >= 75 ? PLOT_COLORS.warn : PLOT_COLORS.accent;

  return (
    <Plot
      title={`Filesystems (${fs.length})`}
      // Enough room per bar to stay legible; freya has 21 mounts.
      height={Math.max(120, 26 * fs.length + 40)}
      data={[
        {
          type: "bar",
          orientation: "h",
          x: fs.map((f) => f.pct),
          y: fs.map((f) => f.mountpoint),
          marker: { color: fs.map((f) => color(f.pct)) },
          text: fs.map((f) => `${humanBytes(f.usedBytes)} / ${humanBytes(f.sizeBytes)}`),
          textposition: "auto",
          insidetextfont: { color: PLOT_COLORS.surface, size: 9 },
          outsidetextfont: { color: PLOT_COLORS.axis, size: 9 },
          hovertemplate: "%{y}: %{x:.1f}%<extra></extra>",
        },
      ]}
      layoutExtra={{
        xaxis: { range: [0, 100], ticksuffix: "%", gridcolor: PLOT_COLORS.grid },
        yaxis: { automargin: true, gridcolor: "rgba(0,0,0,0)" },
        margin: { l: 8, r: 12, t: 26, b: 28 },
        bargap: 0.35,
      }}
    />
  );
}

/**
 * Plotly, loaded on first use.
 *
 * The library is ~1.1MB — more than half the app's bundle — and only this tab
 * needs it, so it's a dynamic import that vite splits into its own chunk. Someone
 * who never opens a node's Metrics tab never downloads or parses it. The promise
 * is cached at module scope so five charts on one tab share one load.
 */
let plotlyPromise: Promise<typeof import("plotly.js-basic-dist-min")> | null = null;
function loadPlotly() {
  plotlyPromise ??= import("plotly.js-basic-dist-min");
  return plotlyPromise;
}

/**
 * One Plotly chart.
 *
 * `Plotly.react` rather than `newPlot`: it diffs against what's already drawn, so
 * a new point every poll updates the existing traces instead of tearing the plot
 * down and rebuilding it — which would flicker and lose any hover.
 */
function Plot({
  title,
  data,
  layoutExtra,
  height = 150,
}: {
  title: string;
  data: unknown[];
  layoutExtra?: Record<string, unknown>;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Resolve layout colours from the plot host so a dark panel surface wins.
    const layout = { ...baseLayout(title, height, ref.current), ...layoutExtra };
    void loadPlotly().then((Plotly) => {
      // The tab can close while the chunk is in flight.
      if (cancelled || !ref.current) return;
      void Plotly.react(ref.current, data as never, layout as never, PLOT_CONFIG as never);
    });
    return () => {
      cancelled = true;
    };
  });

  // Purge on unmount only: Plotly attaches listeners and DOM that leak if the
  // node is simply dropped.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) void loadPlotly().then((Plotly) => Plotly.purge(el));
    };
  }, []);

  return <div className={styles.plot} ref={ref} />;
}

/** "42%" for a used/total pair. */
function pct(used: number, total: number): string {
  return `${((100 * used) / Math.max(total, 1)).toFixed(0)}%`;
}

/** Stable empty array so the selector doesn't churn renders. */
const EMPTY: NodeSample[] = [];
