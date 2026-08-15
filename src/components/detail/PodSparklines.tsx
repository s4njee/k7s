/**
 * Pod detail-header sparklines (B44): half an hour of CPU/MEM history backfilled
 * from Prometheus, drawn as two compact inline-SVG sparklines with the current
 * values.
 *
 * B58: Overlay resource requests/limits as reference lines on the sparklines.
 * Requests are dashed, limits are solid. The area above 80% of limit tints amber,
 * above 95% tints red. Tooltip shows exact values.
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
import type { PodPoint, PodResources } from "../../providers/types";

export function PodSparklines({
  namespace,
  name,
  resources,
}: {
  namespace: string;
  name: string;
  resources?: PodResources;
}) {
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
  const cpuLimit = resources?.cpuLimitMillis;
  const cpuRequest = resources?.cpuRequestMillis;
  const memLimit = resources?.memLimitBytes;
  const memRequest = resources?.memRequestBytes;

  // Compute thresholds for tinting
  const cpuLimitPct = cpuLimit ? (latest.cpuMillis / cpuLimit) * 100 : 0;
  const memLimitPct = memLimit ? (latest.memBytes / memLimit) * 100 : 0;
  const cpuWarn = cpuLimitPct > 95;
  const cpuWarnAmber = cpuLimitPct > 80 && !cpuWarn;
  const memWarn = memLimitPct > 95;
  const memWarnAmber = memLimitPct > 80 && !memWarn;

  return (
    <div className={styles.row}>
      <SparklineCell
        label="cpu"
        value={formatCpu(latest.cpuMillis)}
        series={points.map((p) => p.cpuMillis)}
        color="var(--accent)"
        limit={cpuLimit}
        request={cpuRequest}
        warn={cpuWarn}
        warnAmber={cpuWarnAmber}
      />
      <SparklineCell
        label="mem"
        value={formatMem(latest.memBytes)}
        series={points.map((p) => p.memBytes)}
        color="var(--status-ok)"
        limit={memLimit}
        request={memRequest}
        warn={memWarn}
        warnAmber={memWarnAmber}
      />
    </div>
  );
}

/** One labelled sparkline: the label + current value, with the history below.
 *  B58: optional limit/request lines and warning tints.
 */
function SparklineCell({
  label,
  value,
  series,
  color,
  limit,
  request,
  warn,
  warnAmber,
}: {
  label: string;
  value: string;
  series: number[];
  color: string;
  limit?: number | null;
  request?: number | null;
  warn?: boolean;
  warnAmber?: boolean;
}) {
  return (
    <div className={styles.cell}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{value}</span>
      </div>
      <Sparkline
        series={series}
        color={color}
        limit={limit}
        request={request}
        warn={warn}
        warnAmber={warnAmber}
      />
    </div>
  );
}

const W = 96;
const H = 22;
const PAD = 2;

/** A minimal inline-SVG sparkline: a normalised line over a soft area fill.
 *  B58: supports limit/request reference lines and warning tints.
 */
function Sparkline({
  series,
  color,
  limit,
  request,
  warn,
  warnAmber,
}: {
  series: number[];
  color: string;
  limit?: number | null;
  request?: number | null;
  warn?: boolean;
  warnAmber?: boolean;
}) {
  const dataMin = Math.min(...series);
  const min = Math.min(dataMin, 0);
  const max = Math.max(...series, limit ?? 0, request ?? 0);
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

  const limitY = limit != null ? H - PAD - ((limit - min) / span) * (H - PAD * 2) : null;
  const requestY = request != null ? H - PAD - ((request - min) / span) * (H - PAD * 2) : null;

  // Warning tints: red above 95%, amber 80-95%
  const warnAmberY = max - (max - min) * 0.8;
  const warnRedY = max - (max - min) * 0.95;

  return (
    <svg className={styles.spark} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {/* Inline style (not an attribute) so the CSS var resolves. */}
      {/* Warning tints (B58): red >95%, amber 80-95% */}
      {warn && (
        <>
          <rect
            x={0}
            y={0}
            width={W}
            height={H - Math.max(warnRedY, 0)}
            style={{ fill: "var(--status-err)", opacity: 0.12 }}
          />
          {warnAmber && (
            <rect
              x={0}
              y={Math.max(warnRedY, 0)}
              width={W}
              height={Math.max(0, warnRedY - warnAmberY)}
              style={{ fill: "var(--status-warn)", opacity: 0.12 }}
            />
          )}
        </>
      )}
      {/* Limit line (solid red) */}
      {limitY != null && (
        <line
          x1={0}
          y1={limitY}
          x2={W}
          y2={limitY}
          className={styles.limitLine}
        />
      )}
      {/* Request line (dashed gray) */}
      {requestY != null && (
        <line
          x1={0}
          y1={requestY}
          x2={W}
          y2={requestY}
          className={styles.requestLine}
        />
      )}
      {/* Inline style (not an attribute) so the CSS var resolves. */}
      <path d={area} style={{ fill: color, opacity: 0.14 }} />
      <path d={line} style={{ fill: "none", stroke: color, strokeWidth: 1.4 }} />
    </svg>
  );
}
