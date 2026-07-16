/**
 * The generic resource table (Design §3), used for every kind. Columns come from
 * the kind's metadata; rows come from the store and are namespace-filtered,
 * metrics-overlaid (pods/nodes), and tone-colored. Rows open the detail panel on
 * click, except the read-only Events feed (B14).
 */

import { useMemo, useRef } from "react";
import styles from "./ResourceTable.module.css";
import { useStore } from "../../store";
import { useNow } from "../../hooks/useNow";
import { useTableKeys } from "../../hooks/useTableKeys";
import { toneColor } from "../../lib/tone";
import { formatAge, formatCpu, formatMem } from "../../lib/format";
import { CLUSTER_SCOPED, KIND_META, type ResourceKind } from "../../lib/kinds";
import { sortRows } from "../../lib/sort";
import type { Cell, NodeMetricsMap, PodMetricsMap, Row } from "../../providers/types";

export function ResourceTable() {
  const nav = useStore((s) => s.nav);
  const namespace = useStore((s) => s.namespace);
  const tableFilter = useStore((s) => s.tableFilter);
  const setTableFilter = useStore((s) => s.setTableFilter);
  const sortCol = useStore((s) => s.sortCol);
  const sortDir = useStore((s) => s.sortDir);
  const toggleSort = useStore((s) => s.toggleSort);
  const allRows = useStore((s) => s.rows[nav]);
  const podMetrics = useStore((s) => s.podMetrics);
  const nodeMetrics = useStore((s) => s.nodeMetrics);
  // The full pods list, used to derive per-namespace pod counts (B12).
  const podRows = useStore((s) => s.rows.pods);
  const selectedUid = useStore((s) => s.selectedRow?.uid ?? null);
  const selectRow = useStore((s) => s.selectRow);

  // Age columns re-render on a 30s tick.
  const now = useNow();

  const columns = KIND_META[nav].columns;

  // The Events feed is a read-only view (B14): rows have no detail panel, so they
  // neither select on click nor on Enter.
  const clickable = nav !== "events";
  const onSelect = clickable ? selectRow : () => {};

  // Namespace filter (cluster-scoped kinds ignore it), text filter, metrics overlay,
  // then optional column sort. When no column is chosen, server order is preserved
  // (which is what orders the Events feed — Warnings first, then newest).
  const rows = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    const filtered = allRows.filter((r) => {
      // Namespace filter — cluster-scoped kinds ignore it. Events are namespaced
      // (despite living in the Cluster nav group), so the filter narrows them.
      if (!CLUSTER_SCOPED.has(nav) && namespace !== "all" && r.namespace !== namespace) {
        return false;
      }
      if (!q) return true;
      // Text filter: name substring for real resources. An event's name is an
      // opaque id ("my-pod.17c3f…"), so match its cells instead — that's what
      // makes filtering by reason/object/message work.
      return nav === "events"
        ? r.cells.some((c) => c.text.toLowerCase().includes(q))
        : r.name.toLowerCase().includes(q);
    });
    const overlaid = overlayMetrics(nav, filtered, podMetrics, nodeMetrics, podRows);
    return sortCol === null ? overlaid : sortRows(overlaid, sortCol, sortDir, now);
  }, [nav, allRows, namespace, tableFilter, podMetrics, nodeMetrics, podRows, sortCol, sortDir, now]);

  // Keyboard navigation: highlighted row index + `/`-to-focus the filter.
  const filterRef = useRef<HTMLInputElement>(null);
  const highlight = useTableKeys(rows, onSelect, () => filterRef.current?.focus(), nav);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <span className={styles.searchIcon}>⌕</span>
          <input
            ref={filterRef}
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
            {columns.map((col, i) => (
              <th key={col} className={styles.th} onClick={() => toggleSort(i)}>
                {col}
                {sortCol === i && (
                  <span className={styles.sortArrow}>{sortDir === "asc" ? " ▲" : " ▼"}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const selected = row.uid === selectedUid;
            return (
              <tr
                key={row.uid}
                className={[
                  styles.row,
                  clickable ? styles.rowClickable : "",
                  selected ? styles.rowSelected : "",
                  i === highlight ? styles.rowHighlight : "",
                ].join(" ")}
                onClick={() => onSelect(row)}
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
 * Overlay live values that aren't carried on the row itself:
 *  - pods CPU/MEM and node CPU/MEMORY from the metrics feed (real mode; demo keeps
 *    the baked-in values), and
 *  - the Namespaces PODS count, derived from the live pods list (B12).
 */
function overlayMetrics(
  kind: ResourceKind,
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
