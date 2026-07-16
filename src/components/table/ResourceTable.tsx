/**
 * The generic resource table (Design §3), used for every kind. Columns come from
 * the kind's metadata; rows come from the store and are namespace-filtered,
 * metrics-overlaid (pods/nodes), and tone-colored. Rows open the detail panel on
 * click, except the read-only Events feed (B14).
 *
 * Large tables render only the rows near the viewport (B21). Filtering, metrics
 * overlay and sorting all still run over the full dataset — only what reaches the
 * DOM is windowed. See `VIRTUAL_THRESHOLD` for why small tables opt out entirely.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./ResourceTable.module.css";
import { rowsFor, useStore } from "../../store";
import { useNow } from "../../hooks/useNow";
import { useTableKeys } from "../../hooks/useTableKeys";
import { toneColor } from "../../lib/tone";
import { formatAge, formatCpu, formatMem } from "../../lib/format";
import { isClusterScoped, kindMeta, type KindId } from "../../lib/kinds";
import { sortRows } from "../../lib/sort";
import { rowWindow, scrollToShow, type RowWindow } from "../../lib/virtual";
import type { Cell, NodeMetricsMap, PodMetricsMap, Row } from "../../providers/types";

export function ResourceTable() {
  const nav = useStore((s) => s.nav);
  const namespace = useStore((s) => s.namespace);
  const tableFilter = useStore((s) => s.tableFilter);
  const setTableFilter = useStore((s) => s.setTableFilter);
  const sortCol = useStore((s) => s.sortCol);
  const sortDir = useStore((s) => s.sortDir);
  const toggleSort = useStore((s) => s.toggleSort);
  const allRows = useStore((s) => rowsFor(s.rows, nav));
  const podMetrics = useStore((s) => s.podMetrics);
  const nodeMetrics = useStore((s) => s.nodeMetrics);
  // The full pods list, used to derive per-namespace pod counts (B12).
  const podRows = useStore((s) => s.rows.pods);
  const selectedUid = useStore((s) => s.selectedRow?.uid ?? null);
  const selectRow = useStore((s) => s.selectRow);
  const customKinds = useStore((s) => s.customKinds);

  // Age columns re-render on a 30s tick.
  const now = useNow();

  // Undefined only for a nav pointing at a kind this cluster doesn't have — e.g.
  // a persisted CRD kind after switching to a cluster without that CRD (B15).
  const meta = kindMeta(nav, customKinds);
  const columns = meta?.columns ?? [];

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
      if (!isClusterScoped(nav, customKinds) && namespace !== "all" && r.namespace !== namespace) {
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
  }, [
    nav,
    allRows,
    namespace,
    tableFilter,
    podMetrics,
    nodeMetrics,
    podRows,
    sortCol,
    sortDir,
    now,
    customKinds,
  ]);

  // Keyboard navigation: highlighted row index + `/`-to-focus the filter.
  const filterRef = useRef<HTMLInputElement>(null);
  const highlight = useTableKeys(rows, onSelect, () => filterRef.current?.focus(), nav);

  // Windowing (B21). Sorting/filtering above still run over the full dataset;
  // only what reaches the DOM is trimmed.
  const scrollRef = useRef<HTMLDivElement>(null);
  const { virtual, window: win } = useVirtualRows(scrollRef, rows.length);
  const visible = virtual ? rows.slice(win.start, win.end) : rows;

  // Keep the keyboard highlight on screen. Virtualized rows may not exist in the
  // DOM at all, so the position is computed rather than scrollIntoView'd.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || highlight < 0) return;
    if (virtual) {
      const to = scrollToShow(highlight, el.scrollTop, el.clientHeight, ROW_HEIGHT, headerHeight(el));
      if (to !== null) el.scrollTop = to;
    } else {
      // Natural row heights here, so let the browser measure it.
      el.querySelector(`[data-row-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [highlight, virtual]);

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
      <div className={styles.wrap} ref={scrollRef}>
        <table className={`${styles.table} ${virtual ? styles.tableFixed : ""}`}>
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
          {/* Spacers stand in for the rows outside the window, so the scrollbar
              reflects the whole list rather than what's rendered. */}
          {win.padTop > 0 && <tr style={{ height: win.padTop }} />}
          {visible.map((row, i) => {
            const index = virtual ? win.start + i : i;
            const selected = row.uid === selectedUid;
            return (
              <tr
                key={row.uid}
                data-row-index={index}
                className={[
                  styles.row,
                  virtual ? styles.rowFixed : "",
                  clickable ? styles.rowClickable : "",
                  selected ? styles.rowSelected : "",
                  index === highlight ? styles.rowHighlight : "",
                ].join(" ")}
                onClick={() => onSelect(row)}
              >
                {row.cells.map((cell, j) => (
                  <td key={j} className={styles.td} style={{ color: toneColor(cell.tone) }}>
                    {renderCell(cell, now)}
                  </td>
                ))}
              </tr>
            );
          })}
          {win.padBottom > 0 && <tr style={{ height: win.padBottom }} />}
        </tbody>
        </table>
        {rows.length === 0 && <div className={styles.empty}>no resources match filter</div>}
      </div>
    </div>
  );
}

/**
 * Row height used by the windowing math, enforced by `.rowFixed` (B21). The
 * design's rows are 28px; virtualized rows are pinned to exactly that so the
 * spacer arithmetic can't drift out of step with the real layout.
 */
const ROW_HEIGHT = 28;

/** Rows kept beyond each edge of the viewport, so fast scrolling stays filled. */
const OVERSCAN = 20;

/**
 * Row count above which the table windows its rendering.
 *
 * Below it, every row is rendered exactly as before — which is what keeps the
 * table pixel-identical at ordinary cluster sizes (freya's largest kind is 71
 * rows). That matters because windowing forces `table-layout: fixed`: with the
 * default auto layout, column widths are computed from the *rendered* rows, so a
 * windowed table would visibly re-jig its columns as you scrolled.
 */
const VIRTUAL_THRESHOLD = 200;

/** The sticky header's height, so a row isn't scrolled to sit behind it. */
function headerHeight(scrollEl: HTMLElement): number {
  return scrollEl.querySelector("thead")?.getBoundingClientRect().height ?? 0;
}

/**
 * Track scroll position and viewport height, and derive the row window from them.
 * Returns `virtual: false` for lists short enough to render whole.
 */
function useVirtualRows(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  total: number,
): { virtual: boolean; window: RowWindow } {
  const virtual = total > VIRTUAL_THRESHOLD;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // A ref, so the scroll handler doesn't have to be re-attached when it flips.
  const virtualRef = useRef(virtual);
  virtualRef.current = virtual;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      // Short lists render whole; re-rendering them on every scroll event would
      // be pure waste.
      if (virtualRef.current) setScrollTop(el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scrollRef]);

  const window = useMemo(
    () =>
      virtual
        ? rowWindow(total, scrollTop, viewportH, ROW_HEIGHT, OVERSCAN)
        : { start: 0, end: total, padTop: 0, padBottom: 0 },
    [virtual, total, scrollTop, viewportH],
  );

  return { virtual, window };
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
