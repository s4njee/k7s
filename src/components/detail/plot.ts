/**
 * Plotly theming and formatting for the node metrics plots (B27).
 *
 * Plotly can't read CSS variables (same constraint as xterm in ShellTab), so the
 * colours are mirrored from src/styles/tokens.css. If a token changes, change it
 * here too — these are the only hardcoded colours in the app, and they exist for
 * a reason rather than by accident.
 */

/** Mirrors of the design tokens Plotly needs as literal values. */
export const PLOT_COLORS = {
  /** --bg-terminal — the plot surface, matching the logs/YAML panels. */
  surface: "#0a0a0c",
  /** --text-secondary — axis labels. */
  axis: "#a4a4ae",
  /** --text-faint — grid lines want to be quieter than the data. */
  grid: "#26262b",
  /** --accent */
  accent: "#4d9fff",
  /** --status-ok */
  ok: "#9ece6a",
  /** --status-warn */
  warn: "#e0af68",
  /** --status-err */
  err: "#f7768e",
  /** A fifth series colour: --accent-hover, for load15. */
  accent2: "#7db8ff",
} as const;

/** Plotly layout shared by every chart here. */
export function baseLayout(title: string, height: number): Record<string, unknown> {
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
