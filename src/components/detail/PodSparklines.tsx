/**
 * Pod detail-header sparklines (B44): half an hour of CPU/MEM history backfilled
 * from Prometheus, drawn as two compact inline-SVG sparklines with the current
 * values.
 *
 * Fetch-on-open — the backend fires exactly two range queries (one per metric),
 * once per pod selection; switching pods or closing the panel discards any
 * in-flight result. A cluster without Prometheus resolves empty and the header
 * renders exactly as before: nothing is surfaced as an error.
 */

import { useEffect, useState } from "react";
import styles from "./PodSparklines.module.css";
import { getProvider } from "../../providers";
import { formatCpu, formatMem } from "../../lib/format";
import type { PodPoint } from "../../providers/types";

export function PodSparklines({ namespace, name }: { namespace: string; name: string }) {
  const [points, setPoints] = useState<PodPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    void getProvider()
      .podHistory(namespace, name)
      .then((p) => {
        if (!cancelled) setPoints(p);
      })
      .catch(() => {
        // No history is a normal state, not an error worth showing — the pod
        // still has its live Metrics tab. Resolve to empty like a cluster
        // without Prometheus would.
        if (!cancelled) setPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [namespace, name]);

  // Nothing to draw (no Prometheus, or too few points) — the header stays
  // exactly as it was before B44.
  if (!points || points.length < 2) return null;

  const latest = points[points.length - 1];
  return (
    <div className={styles.row}>
      <SparklineCell
        label="cpu"
        value={formatCpu(latest.cpuMillis)}
        series={points.map((p) => p.cpuMillis)}
        color="var(--accent)"
      />
      <SparklineCell
        label="mem"
        value={formatMem(latest.memBytes)}
        series={points.map((p) => p.memBytes)}
        color="var(--status-ok)"
      />
    </div>
  );
}

/** One labelled sparkline: the label + current value, with the history below. */
function SparklineCell({
  label,
  value,
  series,
  color,
}: {
  label: string;
  value: string;
  series: number[];
  color: string;
}) {
  return (
    <div className={styles.cell}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{value}</span>
      </div>
      <Sparkline series={series} color={color} />
    </div>
  );
}

/** A minimal inline-SVG sparkline: a normalised line over a soft area fill. */
function Sparkline({ series, color }: { series: number[]; color: string }) {
  const W = 96;
  const H = 22;
  const PAD = 2;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (series.length - 1);

  // x grows right-to-now; y is inverted (svg y is top-down).
  const pts = series.map((v, i) => [
    PAD + i * step,
    H - PAD - ((v - min) / span) * (H - PAD * 2),
  ] as const);
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const lastX = pts[pts.length - 1][0].toFixed(1);
  const firstX = pts[0][0].toFixed(1);
  const area = `${line} L${lastX},${H} L${firstX},${H} Z`;

  return (
    <svg className={styles.spark} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {/* Inline style (not an attribute) so the CSS var resolves. */}
      <path d={area} style={{ fill: color, opacity: 0.14 }} />
      <path d={line} style={{ fill: "none", stroke: color, strokeWidth: 1.4 }} />
    </svg>
  );
}
