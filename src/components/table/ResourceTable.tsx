/**
 * The generic resource table (Design §3), used for every kind. Columns come from
 * the kind's metadata; rows come from the store and are namespace-filtered,
 * metrics-overlaid (pods/nodes), and tone-colored. Rows open the detail panel on
 * click, except the read-only Events feed (B14).
 *
 * Large tables render only the rows near the viewport (B21).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./ResourceTable.module.css";
import { rowsFor, useStore } from "../../store";
import { useNow } from "../../hooks/useNow";
import { useTableKeys } from "../../hooks/useTableKeys";
import { isClusterScoped, kindMeta, navIdForKind } from "../../lib/kinds";
import { sortRows } from "../../lib/sort";
import { parseFilter, matchesFilter } from "../../lib/filter";
import { scrollToShow } from "../../lib/virtual";
import { applyClick, pruneSelection, selectedInOrder, selectionForContextMenu } from "../../lib/selection";
import { RowContextMenu, type ContextMenuAt } from "../actions/RowContextMenu";
import { useVirtualRows, headerHeight, ROW_HEIGHT } from "./useVirtualRows";
import { overlayMetrics } from "./overlayMetrics";
import { TableToolbar } from "./TableToolbar";
import { TableHeader } from "./TableHeader";
import { TableRow } from "./TableRow";
import type { NavTarget, Row } from "../../providers/types";

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
  const podRows = useStore((s) => s.rows.pods);
  const selectedUid = useStore((s) => s.selectedRow?.uid ?? null);
  const selectRow = useStore((s) => s.selectRow);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const clearSelection = useStore((s) => s.clearSelection);
  const navigateTo = useStore((s) => s.navigateTo);
  const customKinds = useStore((s) => s.customKinds);

  const now = useNow();

  const meta = kindMeta(nav, customKinds);
  const columns = meta?.columns ?? [];

  const eventTarget = useCallback(
    (row: Row): NavTarget | null => {
      const inv = row.involved;
      if (!inv) return null;
      const kind = navIdForKind(inv.kind, inv.apiVersion, customKinds);
      return kind ? { kind, namespace: inv.namespace, name: inv.name } : null;
    },
    [customKinds],
  );

  const rowClickable = useCallback(
    (row: Row): boolean =>
      nav === "events" || nav === "problems" ? eventTarget(row) !== null : true,
    [nav, eventTarget],
  );

  const orderedUidsRef = useRef<string[]>([]);

  const onSelect = useCallback(
    (row: Row, mods?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      if (nav === "events" || nav === "problems") {
        const target = eventTarget(row);
        if (target) navigateTo(target);
        return;
      }
      const range = mods?.shiftKey ?? false;
      const toggle = (mods?.metaKey ?? false) || (mods?.ctrlKey ?? false);
      if (range || toggle) {
        const current = useStore.getState().selection;
        setSelection(applyClick(current, orderedUidsRef.current, row.uid, { range, toggle }));
        return;
      }
      selectRow(row);
    },
    [nav, eventTarget, navigateTo, selectRow, setSelection],
  );

  const parsed = useMemo(() => parseFilter(tableFilter), [tableFilter]);
  const rows = useMemo(() => {
    const filtered = allRows.filter((r) => {
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

  useEffect(() => {
    const pruned = pruneSelection(selection, orderedUids);
    if (pruned !== selection) setSelection(pruned);
  }, [orderedUids, selection, setSelection]);

  // ---- row context menu (B39) ----
  const [menuAt, setMenuAt] = useState<ContextMenuAt | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);

  const menuRows = useMemo(
    () => selectedInOrder(selection, rows),
    [selection, rows],
  );

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, row: Row) => {
      if (nav === "events" || nav === "problems") return;
      e.preventDefault();
      setSelection(selectionForContextMenu(useStore.getState().selection, row.uid));
      setMenuError(null);
      setMenuAt({ x: e.clientX, y: e.clientY });
    },
    [nav, setSelection],
  );

  const filterRef = useRef<HTMLInputElement>(null);
  const highlight = useTableKeys(rows, onSelect, () => filterRef.current?.focus(), nav);

  const scrollRef = useRef<HTMLDivElement>(null);
  const { virtual, window: win } = useVirtualRows(scrollRef, rows.length);
  const visible = virtual ? rows.slice(win.start, win.end) : rows;

  const revealRow = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el || index < 0) return;
      if (virtual) {
        const to = scrollToShow(index, el.scrollTop, el.clientHeight, ROW_HEIGHT, headerHeight(el));
        if (to !== null) el.scrollTop = to;
      } else {
        el.querySelector(`[data-row-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
      }
    },
    [virtual],
  );

  useEffect(() => {
    revealRow(highlight);
  }, [highlight, revealRow]);

  useEffect(() => {
    if (!selectedUid) return;
    revealRow(rows.findIndex((r) => r.uid === selectedUid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, nav]);

  return (
    <div className={styles.container}>
      <TableToolbar
        filterRef={filterRef}
        tableFilter={tableFilter}
        setTableFilter={setTableFilter}
      />
      <div className={styles.wrap} ref={scrollRef}>
        <table className={`${styles.table} ${virtual ? styles.tableFixed : ""}`}>
          <TableHeader
            columns={columns}
            virtual={virtual}
            sortCol={sortCol}
            sortDir={sortDir}
            toggleSort={toggleSort}
          />
          <tbody>
            {win.padTop > 0 && <tr style={{ height: win.padTop }} />}
            {visible.map((row, i) => {
              const index = virtual ? win.start + i : i;
              const selected = row.uid === selectedUid;
              const inSelection = selectionSet.has(row.uid);
              return (
                <TableRow
                  key={row.uid}
                  row={row}
                  index={index}
                  virtual={virtual}
                  clickable={rowClickable(row)}
                  selected={selected}
                  inSelection={inSelection}
                  highlight={index === highlight}
                  now={now}
                  onSelect={onSelect}
                  onContextMenu={onRowContextMenu}
                />
              );
            })}
            {win.padBottom > 0 && <tr style={{ height: win.padBottom }} />}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className={styles.empty}>
            {nav === "problems" ? "nothing wrong — cluster looks healthy" : "no resources match filter"}
          </div>
        )}
      </div>

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
