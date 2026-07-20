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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./ResourceTable.module.css";
import { rowsFor, useStore } from "../../store";
import { useNow } from "../../hooks/useNow";
import { useTableKeys } from "../../hooks/useTableKeys";
import { toneColor } from "../../lib/tone";
import { formatAge, formatCpu, formatMem } from "../../lib/format";
import { isClusterScoped, kindMeta, navIdForKind, type KindId } from "../../lib/kinds";
import { sortRows } from "../../lib/sort";
import { parseFilter, matchesFilter } from "../../lib/filter";
import { rowWindow, scrollToShow, type RowWindow } from "../../lib/virtual";
import type { Cell, NavTarget, NodeMetricsMap, PodMetricsMap, Row } from "../../providers/types";
import { applyClick, pruneSelection, selectedInOrder, selectionForContextMenu } from "../../lib/selection";
import { RowContextMenu, type ContextMenuAt } from "../actions/RowContextMenu";

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
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const clearSelection = useStore((s) => s.clearSelection);
  const navigateTo = useStore((s) => s.navigateTo);
  const customKinds = useStore((s) => s.customKinds);

  // Age columns re-render on a 30s tick.
  const now = useNow();

  // Undefined only for a nav pointing at a kind this cluster doesn't have — e.g.
  // a persisted CRD kind after switching to a cluster without that CRD (B15).
  const meta = kindMeta(nav, customKinds);
  const columns = meta?.columns ?? [];

  // An event row navigates to the object it's about, but only when that object's
  // kind is one we list (B33). Other kinds resolve to null so the row stays inert
  // — the same read-only feel as B14, now the exception rather than the rule.
  const eventTarget = useCallback(
    (row: Row): NavTarget | null => {
      const inv = row.involved;
      if (!inv) return null;
      const kind = navIdForKind(inv.kind, inv.apiVersion, customKinds);
      return kind ? { kind, namespace: inv.namespace, name: inv.name } : null;
    },
    [customKinds],
  );

  // Whether a row responds to a click: every kind but events (always), and an
  // event only when its target resolves.
  const rowClickable = useCallback(
    (row: Row): boolean => (nav === "events" ? eventTarget(row) !== null : true),
    [nav, eventTarget],
  );

  /**
   * The visible rows' uids, in display order.
   *
   * A ref because the ordered list is computed *below* (it depends on the filter,
   * the metrics overlay, and the sort) while the click handler is defined above
   * it, and because range selection needs the order at click time rather than at
   * render time. Keyed by uid throughout — indices move under sorting and the
   * 30-second age re-render.
   */
  const orderedUidsRef = useRef<string[]>([]);

  /**
   * Click a row. Modifiers extend the selection instead of replacing it (B39).
   *
   * `selectRow` deliberately still runs for a plain click — it also resets the
   * detail panel's per-object state — but a modified click must *not*, or
   * ⌘-clicking a second pod would swap the panel out from under the selection
   * you were building.
   */
  const onSelect = useCallback(
    (row: Row, mods?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      if (nav === "events") {
        const target = eventTarget(row);
        if (target) navigateTo(target);
        return;
      }
      // ⌘ on macOS, Ctrl elsewhere. Mapped here, once, so lib/selection stays
      // platform-agnostic.
      const range = mods?.shiftKey ?? false;
      const toggle = (mods?.metaKey ?? false) || (mods?.ctrlKey ?? false);
      if (range || toggle) {
        // Read the selection from the store rather than the closure. A handler
        // closes over the selection as it was at *render* time, so two clicks
        // landing before React re-renders would both extend from the older
        // anchor — a shift-click could then select a range starting from a row
        // you had already clicked past.
        const current = useStore.getState().selection;
        setSelection(applyClick(current, orderedUidsRef.current, row.uid, { range, toggle }));
        return;
      }
      selectRow(row);
    },
    [nav, eventTarget, navigateTo, selectRow, setSelection],
  );

  // Namespace filter (cluster-scoped kinds ignore it), text filter, metrics overlay,
  // then optional column sort. When no column is chosen, server order is preserved
  // (which is what orders the Events feed — Warnings first, then newest).
  // Parse the filter once per keystroke; it splits into label selectors and free
  // text (B33). With no `key=value` term this is the pre-B33 substring filter.
  const parsed = useMemo(() => parseFilter(tableFilter), [tableFilter]);
  const rows = useMemo(() => {
    const filtered = allRows.filter((r) => {
      // Namespace filter — cluster-scoped kinds ignore it. Events are namespaced
      // (despite living in the Cluster nav group), so the filter narrows them.
      if (!isClusterScoped(nav, customKinds) && namespace !== "all" && r.namespace !== namespace) {
        return false;
      }
      return matchesFilter(r, parsed, nav);
    });
    const overlaid = overlayMetrics(nav, filtered, podMetrics, nodeMetrics, podRows);
    return sortCol === null ? overlaid : sortRows(overlaid, sortCol, sortDir, now);
  }, [
    nav,
    allRows,
    namespace,
    parsed,
    podMetrics,
    nodeMetrics,
    podRows,
    sortCol,
    sortDir,
    now,
    customKinds,
  ]);

  const selectionSet = useMemo(() => new Set(selection.selected), [selection]);
  const orderedUids = useMemo(() => rows.map((r) => r.uid), [rows]);
  orderedUidsRef.current = orderedUids;

  // Drop selected rows that are no longer visible (B39). Filtering, sorting and
  // watch updates can hide rows the selection still names, and a bulk action must
  // never act on something the user can no longer see it selected.
  useEffect(() => {
    const pruned = pruneSelection(selection, orderedUids);
    // pruneSelection preserves identity when nothing changed, so this can't loop.
    if (pruned !== selection) setSelection(pruned);
  }, [orderedUids, selection, setSelection]);

  // ---- row context menu (B39) ----
  const [menuAt, setMenuAt] = useState<ContextMenuAt | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);

  /** The rows a context-menu action would apply to, in display order. */
  const menuRows = useMemo(
    () => selectedInOrder(selection, rows),
    [selection, rows],
  );

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, row: Row) => {
      // Events navigate rather than act, so there is nothing to offer.
      if (nav === "events") return;
      e.preventDefault();
      // Right-clicking outside the selection collapses to this row; inside it,
      // the selection stands (see selectionForContextMenu). Read from the store
      // for the same staleness reason as onSelect.
      setSelection(selectionForContextMenu(useStore.getState().selection, row.uid));
      setMenuError(null);
      setMenuAt({ x: e.clientX, y: e.clientY });
    },
    [nav, setSelection],
  );

  // Keyboard navigation: highlighted row index + `/`-to-focus the filter.
  const filterRef = useRef<HTMLInputElement>(null);
  const highlight = useTableKeys(rows, onSelect, () => filterRef.current?.focus(), nav);

  // Windowing (B21). Sorting/filtering above still run over the full dataset;
  // only what reaches the DOM is trimmed.
  const scrollRef = useRef<HTMLDivElement>(null);
  const { virtual, window: win } = useVirtualRows(scrollRef, rows.length);
  const visible = virtual ? rows.slice(win.start, win.end) : rows;

  /** Bring row `index` on screen, whichever rendering mode is in play. */
  const revealRow = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el || index < 0) return;
      if (virtual) {
        // A windowed row may not exist in the DOM at all, so its position is
        // computed rather than scrollIntoView'd.
        const to = scrollToShow(index, el.scrollTop, el.clientHeight, ROW_HEIGHT, headerHeight(el));
        if (to !== null) el.scrollTop = to;
      } else {
        // Natural row heights here, so let the browser measure it.
        el.querySelector(`[data-row-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
      }
    },
    [virtual],
  );

  // Keep the keyboard highlight on screen.
  useEffect(() => {
    revealRow(highlight);
  }, [highlight, revealRow]);

  // Same for a row selected from somewhere other than this table — the command
  // palette jumps straight to an object (B28), and landing on it scrolled out of
  // sight would make the jump feel like it missed. Keyed on the uid rather than
  // the index so a live row update (a restart count ticking) doesn't yank the
  // scroll back while you're reading elsewhere.
  useEffect(() => {
    if (!selectedUid) return;
    revealRow(rows.findIndex((r) => r.uid === selectedUid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, nav]);

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
        {/* Fixed layout takes its widths from <col>, and divides the width
            equally when there are none — which would squeeze NAME to the same
            share as RESTARTS. Only needed in the windowed path; auto layout
            sizes to content on its own. */}
        {virtual && (
          <colgroup>
            {columns.map((col) => (
              <col key={col} style={{ width: columnWidth(col) }} />
            ))}
          </colgroup>
        )}
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
            // Two distinct things (B39): the row whose detail panel is open, and
            // the rows a bulk action would hit. They coincide for a plain click,
            // but a ⌘-click adds to the selection without moving the panel — so a
            // row can be in the selection without being the panel's row.
            const selected = row.uid === selectedUid;
            const inSelection = selectionSet.has(row.uid);
            return (
              <tr
                key={row.uid}
                data-row-index={index}
                className={[
                  styles.row,
                  virtual ? styles.rowFixed : "",
                  rowClickable(row) ? styles.rowClickable : "",
                  selected ? styles.rowSelected : "",
                  inSelection && !selected ? styles.rowInSelection : "",
                  index === highlight ? styles.rowHighlight : "",
                ].join(" ")}
                // Height comes from the same constant the spacer math uses, so the
                // two cannot drift apart. Natural height when not windowed.
                style={virtual ? { height: ROW_HEIGHT } : undefined}
                onClick={(e) => onSelect(row, e)}
                onContextMenu={(e) => onRowContextMenu(e, row)}
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

      {/* Bulk-action failures (B39). In the table rather than the detail panel,
          because a bulk action can be run entirely from the row menu with no
          panel open — reporting into the panel would silently swallow it. */}
      {menuError && (
        <div className={styles.actionError} onClick={() => setMenuError(null)} title="dismiss">
          {menuError}
        </div>
      )}

      {menuAt && menuRows.length > 0 && (
        <RowContextMenu
          at={menuAt}
          kind={nav}
          rows={menuRows}
          onError={setMenuError}
          scrollHost={scrollRef.current}
          onClose={() => setMenuAt(null)}
          onGone={clearSelection}
        />
      )}
    </div>
  );
}

/**
 * Row height used by the windowing math (B21), and the single source of it: it's
 * applied to windowed rows inline, so the spacer arithmetic and the real layout
 * cannot disagree. The design's rows are 28px.
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
 * Width for a column in the windowed path, keyed by header name (B21).
 *
 * Windowing forces `table-layout: fixed`, which sizes columns from `<col>` and
 * splits the width *equally* when there are none — so without this, a pod name
 * would get the same share as its restart count. Auto layout does this by
 * measuring content, which is exactly what windowing takes away.
 *
 * Names and free text get the room; short, bounded values get only what they
 * need. Anything unlisted (including CRD columns) falls back to a middling share.
 */
function columnWidth(header: string): string {
  switch (header) {
    case "NAME":
    case "MESSAGE":
      return "22%";
    case "OBJECT":
    case "HOSTS":
    case "IMAGE":
      return "16%";
    case "NAMESPACE":
    case "REASON":
    case "PORTS":
    case "CLUSTER-IP":
    case "SCHEDULE":
      return "12%";
    case "AGE":
    case "READY":
    case "COUNT":
    case "TYPE":
    case "STATUS":
    case "RESTARTS":
    case "CPU":
    case "MEM":
      return "8%";
    default:
      return "10%";
  }
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

  // Seed from the DOM whenever windowing engages. While it was off the handler
  // below ignored scrolling, so the state can be stale by now — switching to a
  // short kind lets the browser clamp scrollTop to 0 unobserved, and windowing
  // around that abandoned offset would render the window behind a huge spacer,
  // i.e. a blank table.
  useEffect(() => {
    const el = scrollRef.current;
    if (virtual && el) setScrollTop(el.scrollTop);
  }, [virtual, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      // Short lists render whole; re-rendering them on every scroll event would
      // be pure waste. The effect above repairs the state when this stops.
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
