/**
 * Overlay live metrics that aren't carried on the row itself:
 *  - pods CPU/MEM and node CPU/MEMORY from the metrics feed
 *  - the Namespaces PODS count, derived from the live pods list (B12).
 */

import { formatCpu, formatMem } from "../../lib/format";
import type { KindId, NodeMetricsMap, PodMetricsMap, Row } from "../../providers/types";

export function overlayMetrics(
  kind: KindId,
  rows: Row[],
  podMetrics: PodMetricsMap,
  nodeMetrics: NodeMetricsMap,
  podRows: Row[],
): Row[] {
  if (kind === "pods") {
    return rows.map((r) => {
      const m = podMetrics[`${r.namespace}/${r.name}`];
      if (!m) return r;
      const cells = r.cells.slice();
      // Pods columns: NAME,NAMESPACE,READY,RESTARTS,CPU(4),MEM(5),AGE,STATUS.
      // Carry the raw numbers as sort keys (units aren't lexically comparable).
      cells[4] = { ...cells[4], text: formatCpu(m.cpuMillis), sort: m.cpuMillis };
      cells[5] = { ...cells[5], text: formatMem(m.memBytes), sort: m.memBytes };
      return { ...r, cells };
    });
  }
  if (kind === "nodes") {
    return rows.map((r) => {
      const m = nodeMetrics[r.name];
      if (!m) return r;
      const cells = r.cells.slice();
      // Nodes columns: NAME,STATUS,ROLES,CPU(3),MEMORY(4),VERSION
      cells[3] = { ...cells[3], text: `${Math.round(m.cpuPercent)}%` };
      cells[4] = { ...cells[4], text: `${Math.round(m.memPercent)}%` };
      return { ...r, cells };
    });
  }
  if (kind === "namespaces") {
    // Count pods per namespace across all watched pods (watchers are cluster-wide,
    // so this is the true count). Row name is the namespace name.
    const counts = new Map<string, number>();
    for (const p of podRows) {
      counts.set(p.namespace ?? "", (counts.get(p.namespace ?? "") ?? 0) + 1);
    }
    return rows.map((r) => {
      const cells = r.cells.slice();
      // Namespaces columns: NAME,STATUS,PODS(2),AGE
      const count = counts.get(r.name) ?? 0;
      cells[2] = { ...cells[2], text: String(count), sort: count };
      return { ...r, cells };
    });
  }
  return rows;
}
