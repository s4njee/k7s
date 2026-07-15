/**
 * The generic resource table (Design §3), used for all twelve kinds. Columns come
 * from the kind's metadata; rows come from the store and are namespace-filtered,
 * metrics-overlaid (pods/nodes), and tone-colored. Pod rows are clickable and open
 * the detail panel; other kinds are not interactive.
 */

import { useMemo } from "react";
import styles from "./ResourceTable.module.css";
import { useStore } from "../../store";
import { useNow } from "../../hooks/useNow";
import { toneColor } from "../../lib/tone";
import { formatAge, formatCpu, formatMem } from "../../lib/format";
import { CLUSTER_SCOPED, KIND_META, type ResourceKind } from "../../lib/kinds";
import type { Cell, NodeMetricsMap, PodMetricsMap, Row } from "../../providers/types";

export function ResourceTable() {
  const nav = useStore((s) => s.nav);
  const namespace = useStore((s) => s.namespace);
  const tableFilter = useStore((s) => s.tableFilter);
  const setTableFilter = useStore((s) => s.setTableFilter);
  const allRows = useStore((s) => s.rows[nav]);
  const podMetrics = useStore((s) => s.podMetrics);
  const nodeMetrics = useStore((s) => s.nodeMetrics);
  const selectedUid = useStore((s) => s.selectedPod?.uid ?? null);
  const selectPod = useStore((s) => s.selectPod);

  // Age columns re-render on a 30s tick.
  const now = useNow();

  const columns = KIND_META[nav].columns;
  const isPods = nav === "pods";

  // Namespace filter (cluster-scoped kinds ignore it), name filter, metrics overlay.
  const rows = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    const filtered = allRows.filter((r) => {
      // Namespace filter — cluster-scoped kinds ignore it.
      if (!CLUSTER_SCOPED.has(nav) && namespace !== "all" && r.namespace !== namespace) {
        return false;
      }
      // Name filter (case-insensitive substring).
      return !q || r.name.toLowerCase().includes(q);
    });
    return overlayMetrics(nav, filtered, podMetrics, nodeMetrics);
  }, [nav, allRows, namespace, tableFilter, podMetrics, nodeMetrics]);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <span className={styles.searchIcon}>⌕</span>
          <input
            className={styles.searchInput}
            value={tableFilter}
            onChange={(e) => setTableFilter(e.target.value)}
            placeholder="filter…"
            data-table-filter
          />
        </div>
      </div>
      <div className={styles.wrap}>
        <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col} className={styles.th}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = row.uid === selectedUid;
            return (
              <tr
                key={row.uid}
                className={[
                  styles.row,
                  isPods ? styles.rowClickable : "",
                  selected ? styles.rowSelected : "",
                ].join(" ")}
                onClick={isPods ? () => selectPod(row) : undefined}
              >
                {row.cells.map((cell, i) => (
                  <td key={i} className={styles.td} style={{ color: toneColor(cell.tone) }}>
                    {renderCell(cell, now)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        </table>
        {rows.length === 0 && <div className={styles.empty}>no resources match filter</div>}
      </div>
    </div>
  );
}

/** Render a cell's text: format age timestamps, prefix a status dot when set. */
function renderCell(cell: Cell, now: number): string {
  const text = cell.format === "age" ? formatAge(cell.text, now) : cell.text;
  return cell.dot ? `● ${text}` : text;
}

/**
 * Overlay live metrics onto pod (CPU/MEM) and node (CPU/MEMORY) rows. Rows arrive
 * with "—" placeholders in real mode; the metrics feed (keyed separately) fills
 * them in here. In demo mode the metrics maps are empty and the baked-in values
 * are kept.
 */
function overlayMetrics(
  kind: ResourceKind,
  rows: Row[],
  podMetrics: PodMetricsMap,
  nodeMetrics: NodeMetricsMap,
): Row[] {
  if (kind === "pods") {
    return rows.map((r) => {
      const m = podMetrics[`${r.namespace}/${r.name}`];
      if (!m) return r;
      const cells = r.cells.slice();
      // Pods columns: NAME,NAMESPACE,READY,RESTARTS,CPU(4),MEM(5),AGE,STATUS
      cells[4] = { ...cells[4], text: formatCpu(m.cpuMillis) };
      cells[5] = { ...cells[5], text: formatMem(m.memBytes) };
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
  return rows;
}
