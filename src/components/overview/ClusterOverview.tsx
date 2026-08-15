/**
 * Cluster overview dashboard (B79): the landing page after connect.
 *
 * Reads the active cluster's slices — capacity gauges (requests vs allocatable,
 * with optional usage from the metrics stack), node grid (name + status tone),
 * problems digest (top 5 from deriveProblems), warning events count (from
 * rows.events), workload health counts by READY tone, top 5 resource consumers
 * by CPU from podMetrics. All per-cluster data is cid-scoped via the store.
 */

import styles from "./ClusterOverview.module.css";
import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { invoke } from "@tauri-apps/api/core";
import type { Row } from "../../providers/types";
import { deriveProblems } from "../../lib/problems";
import { toneColor } from "../../lib/tone";
import { formatCpu, formatMem } from "../../lib/format";

export function ClusterOverview() {
  // Active cluster's data slices
  const activeCid = useStore((s) => s.activeCid);
  const rowsByCid = useStore((s) => s.rowsByCid);
      const clusterStatus = useStore((s) => s.clusterStatus);
    
    const rows = rowsByCid[activeCid ?? ""] ?? {};
  const pods = rows.pods ?? [];
  const _nodes = rows.nodes ?? [];
  
  
  
  const events = rows.events ?? [];

  // Fetch allocatable from the backend on mount (B79)
  const [overview, setOverview] = useState<{ cpuAllocatableMillis: number; memAllocatableBytes: number } | null>(null);
  useEffect(() => {
    if (!activeCid) return;
    invoke<{ cpuAllocatableMillis: number; memAllocatableBytes: number }>("cluster_overview", { cid: activeCid ?? "" })
      .then(setOverview)
      .catch(() => {});
  }, [activeCid]);
  const allocCpu = overview?.cpuAllocatableMillis ?? 0;
  const allocMem = overview?.memAllocatableBytes ?? 0;
  const usageCpu = clusterStatus?.cpuPercent ?? 0;
  const usageMem = clusterStatus?.memPercent ?? 0;

  // Sum requests from all pods
  let reqCpu = 0;
  let reqMem = 0;
  for (const p of useStore.getState().rows.pods ?? []) {
    if (p.pod?.resources) {
      if (p.pod.resources.cpuRequestMillis) reqCpu += p.pod.resources.cpuRequestMillis;
      if (p.pod.resources.memRequestBytes) reqMem += p.pod.resources.memRequestBytes;
    }
  }

  // Node grid data
  

  // Problems digest (top 5 from deriveProblems)
  const problems = deriveProblems({ ...rows, events: rows.events ?? [] });
  const topProblems = problems.slice(0, 5);

  // Warning events count (sparkline proxy)
  const warningCount = events.filter((e) => e.cells[0]?.text === "Warning").length;

  // Workload health: count workloads with READY cell tone "warn"
  const workloadKinds = ["deployments", "statefulsets", "daemonsets", "replicasets"] as const;
  let healthy = 0, degraded = 0;
  for (const kind of workloadKinds) {
    for (const w of useStore.getState().rows[kind] ?? []) {
      // READY column tone: "warn" means degraded
      const readyIdx = kind === "daemonsets" ? 3 : 2;
      const readyTone = w.cells[readyIdx]?.tone;
      if (readyTone === "warn") degraded++;
      else healthy++;
    }
  }

  // Top 5 consumers by CPU
    const topConsumers = [...pods]
    .filter((p) => p.cells[4]?.sort != null)
    .sort((a, b) => (b.cells[4]?.sort ?? 0) - (a.cells[4].sort ?? 0))
    .slice(0, 5);



  return (
    <div className={styles.overview}>
      {/* Capacity gauges */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Capacity</h2>
        <div className={styles.gauges}>
          <Gauge
            label="CPU"
            alloc={allocCpu}
            request={reqCpu}
            usage={usageCpu}
            unit="m"
          />
          <Gauge
            label="Memory"
            alloc={allocMem}
            request={reqMem}
            usage={usageMem}
            unit="MiB"
          />
        </div>
      </section>

      {/* Node grid */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Nodes</h2>
        <div className={styles.nodeGrid}>
          {_nodes.map((n) => (
            <NodeTile key={n.uid} node={n} />
          ))}
        </div>
      </section>

      {/* Problems digest */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Problems (top 5)</h2>
        {topProblems.length === 0 ? (
          <p className={styles.empty}>No problems — cluster looks healthy</p>
        ) : (
          <ul className={styles.problemList}>
            {topProblems.map((p) => (
              <li key={p.uid} className={styles.problemItem}>
                <span className={styles.problemSeverity} style={{ color: toneColor(p.cells[0]?.tone) }}>
                  {p.cells[0]?.text}
                </span>
                <span className={styles.problemKind}>{p.cells[1]?.text}</span>
                <span className={styles.problemObj}>{p.cells[2]?.text}</span>
                <span className={styles.problemReason}>{p.cells[3]?.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Warning events sparkline (count per hour — simplified as count for now) */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Warning Events (last 24h)</h2>
        <div className={styles.sparkline}>
          <span className={styles.sparklineCount}>{warningCount}</span>
          <span className={styles.sparklineLabel}>warnings</span>
        </div>
      </section>

      {/* Workload health */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Workloads</h2>
        <div className={styles.workloadCounts}>
          <div className={styles.count}>
            <span className={styles.countVal}>{healthy}</span>
            <span className={styles.countLabel}>healthy</span>
          </div>
          <div className={styles.count}>
            <span className={styles.countVal}>{degraded}</span>
            <span className={styles.countLabel}>degraded</span>
          </div>
        </div>
      </section>

      {/* Top consumers */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Top 5 CPU Consumers</h2>
        <ul className={styles.consumerList}>
          {topConsumers.map((p) => (
            <li key={p.uid} className={styles.consumerItem}>
              <span className={styles.consumerName}>{p.namespace}/{p.name}</span>
              <span className={styles.consumerCpu}>{formatCpu(p.cells[4]?.sort ?? 0)}</span>
              <span className={styles.consumerMem}>{formatMem(p.cells[5]?.sort ?? 0)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// Gauge component
function Gauge({ label, alloc, request, usage, unit }: {
  label: string;
  alloc: number;
  request: number;
  usage: number;
  unit: string;
}) {
  const reqPct = alloc > 0 ? Math.min(100, Math.round((request / alloc) * 100)) : 0;
  const usePct = alloc > 0 ? Math.min(100, Math.round((usage / 100) * 100)) : 0;
  return (
    <div className="gauge">
      <div className="gaugeHeader">
        <span className="gaugeLabel">{label}</span>
        <span className="gaugePct">{reqPct}% requested</span>
      </div>
      <div className="gaugeBar">
        <div className="gaugeFill req" style={{ width: `${Math.min(100, reqPct)}%` }} />
        <div className="gaugeFill use" style={{ width: `${Math.min(100, usePct)}%` }} />
      </div>
      <div className="gaugeFooter">
        <span>{alloc.toLocaleString()} {unit}</span>
        <span>{usage > 0 ? `${usage}% used` : "no metrics"}</span>
      </div>
    </div>
  );
}

// Node tile
function NodeTile({ node }: { node: Row }) {
  const tone = node.cells[1]?.tone ?? "primary";
  return (
    <div className={styles.nodeTile} style={{ borderLeftColor: toneColor(tone) }}>
      <div className={styles.nodeName}>{node.cells[0]?.text}</div>
      <div className={styles.nodeMeta}>
        <span>{node.cells[1]?.text}</span>
        <span>{node.cells[2]?.text}</span>
        <span>{node.cells[3]?.text}</span>
        <span>{node.cells[4]?.text}</span>
      </div>
    </div>
  );
}