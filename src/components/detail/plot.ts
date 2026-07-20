/**
 * Plotly formatting for the node metrics plots (B27).
 *
 * Plotly can't read CSS variables (the same constraint xterm has), so the colours
 * are resolved from the live tokens by lib/theme.ts rather than mirrored as
 * literals here. That mirror used to be the maintenance hazard this file warned
 * about; since B52 there are two palettes, and a stale copy would have meant
 * dark-themed plots sitting on a white panel.
 *
 * Resolved at call time, so a layout built under one palette is stale under the
 * other — MetricsTab keys its plots on the resolved theme to force a rebuild.
 */

import { plotColors } from "../../lib/theme";

export { plotColors };

/** Plotly layout shared by every chart here. Pass `el` inside a dark panel surface. */
export function baseLayout(
  title: string,
  height: number,
  el?: Element | null,
): Record<string, unknown> {
  const PLOT_COLORS = plotColors(el);
  return {
    height,
    title: { text: title, font: { size: 11, color: PLOT_COLORS.axis }, x: 0, xanchor: "left" },
    // Transparent so the panel's own background shows through.
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: PLOT_COLORS.surface,
    font: { family: "JetBrains Mono, ui-monospace, monospace", size: 10, color: PLOT_COLORS.axis },
    // Tight: these are small panels, not a dashboard with room to breathe.
    margin: { l: 52, r: 12, t: 26, b: 28 },
    showlegend: false,
    xaxis: { gridcolor: PLOT_COLORS.grid, zeroline: false, color: PLOT_COLORS.axis },
    yaxis: { gridcolor: PLOT_COLORS.grid, zeroline: false, color: PLOT_COLORS.axis },
    hovermode: "x unified",
  };
}

/** Plotly config shared by every chart: no toolbar, no branding, not zoomable. */
export const PLOT_CONFIG = {
  displayModeBar: false,
  // The plots are a glance, not an analysis tool; drag-zooming a live series that
  // keeps re-rendering fights the user rather than helping.
  staticPlot: false,
  scrollZoom: false,
  responsive: true,
} as const;

/** Bytes as a short human string ("3.2 GiB"). */
export function humanBytes(v: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = Math.abs(v);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  // One decimal below 100 keeps the width stable without losing resolution.
  return `${n < 100 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

/** Bytes/second as a short human string. */
export function humanBps(v: number): string {
  return `${humanBytes(v)}/s`;
}
