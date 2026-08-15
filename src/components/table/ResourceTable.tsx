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
import { formatMsAge } from "../../lib/format";
import { applyClick, pruneSelection, selectedInOrder, selectionForContextMenu } from "../../lib/selection";
import { RowContextMenu, type ContextMenuAt } from "../actions/RowContextMenu";
import { useVirtualRows, headerHeight, ROW_HEIGHT } from "./useVirtualRows";
import { overlayMetrics } from "./overlayMetrics";
import { TableToolbar } from "./TableToolbar";
import { TableHeader } from "./TableHeader";
import { TableRow } from "./TableRow";
import type { NavTarget, Row } from "../../providers/types";

/**
 * The "honest under failure" banner (B74-L): when the current kind is Forbidden,
 * when it's Backoff (still reconnecting), or when the whole cluster is stale.
 * Rows below are retained — a forbidden kind is never a trustworthy empty table,
 * and an outage never reads as "there's nothing here."
 */
function HealthBanner({
  state,
  message,
  ageMs,
  action,
  onRetry,
}: {
  state: "forbidden" | "backoff" | "stale";
  message: string;
  ageMs?: number;
  action?: string;
  onRetry: () => void;
}) {
  const now = Date.now();
  return (
    <div
      role="alert"
      className={`${styles.healthBanner} ${
        state === "forbidden" ? styles.healthBannerForbidden : styles.healthBannerWarn
      }`}
    >
      <span className={styles.healthText}>
        {message}
        {ageMs != null && <span className={styles.healthAge}> · data {formatMsAge(ageMs, now)} old</span>}
        {action && <span className={styles.healthAction}>{action}</span>}
      </span>
      <button className={styles.retryBtn} onClick={onRetry} title="retry now, keeping the data you have">
        retry
      </button>
    </div>
  );
}

export function ResourceTable() {
  const nav = useStore((s) => s.nav);
  const namespace = useStore((s) => s.namespace);
  const tableFilter = useStore((s) => s.tableFilter);
  const setTableFilter = useStore((s) => s.setTableFilter);
  const sortCol = useStore((s) => s.sortCol);
  const sortDir = useStore((s) => s.sortDir);
  const toggleSort = useStore((s) => s.toggleSort);
  const activeRows = useStore((s) => rowsFor(s.rows, nav));
  const rowsByCid = useStore((s) => s.rowsByCid);
  const problemsScope = useStore((s) => s.problemsScope);
  // All-clusters problems scope (B77): merge every connected cluster's problems,
  // each badged with a leading CLUSTER cell.
  const allRows = useMemo(() => {
    if (nav === "problems" && problemsScope === "all") {
      return Object.entries(rowsByCid).flatMap(([cid, rows]) =>
        (rows.problems ?? []).map((p) => ({
          ...p,
          cells: [{ text: cid, tone: "muted" as const }, ...p.cells],
        })),
      );
    }
    return activeRows;
  }, [nav, problemsScope, rowsByCid, activeRows]);
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
  // B74-L: per-kind watcher health + cluster staleness, for the banner above the
  // retained rows.
  const health = useStore((s) => s.watcherHealth[nav]);
  const clusterStatus = useStore((s) => s.clusterStatus);
  const retryKind = useStore((s) => s.retryKind);
  const retryCluster = useStore((s) => s.retryCluster);

  const now = useNow();

  // The banner to show (if any): the kind's own failure outranks cluster
  // staleness, and a live kind on a stale cluster shows the stale banner.
  const banner = useMemo(() => {
    if (health?.state === "forbidden") {
      return (
        <HealthBanner
          state="forbidden"
          message={`k7s can't read ${nav} — permission denied`}
          action={health.error?.action.hint}
          onRetry={() => retryKind(nav)}
        />
      );
    }
    if (health?.state === "backoff") {
      return (
        <HealthBanner
          state="backoff"
          message={`still reconnecting ${nav} — the watcher hit an error`}
          ageMs={health.lastSuccessMs}
          action={health.error?.action.hint}
          onRetry={() => retryKind(nav)}
        />
      );
    }
    if (clusterStatus?.stale) {
      return (
        <HealthBanner
          state="stale"
          message={`cluster unreachable — showing what we have`}
          ageMs={clusterStatus.lastSeenMs}
          action={clusterStatus.error?.action.hint}
          onRetry={retryCluster}
        />
      );
    }
    return null;
  }, [health, clusterStatus, nav, retryKind, retryCluster]);

  const meta = kindMeta(nav, customKinds);
  const columns =
    nav === "problems" && problemsScope === "all"
      ? ["CLUSTER", ...(meta?.columns ?? [])]
      : (meta?.columns ?? []);

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
      // `columns` lets the filter match by column name (B60), e.g. status=…
      return matchesFilter(r, parsed, nav, columns);
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
      {banner}
      <div className={styles.wrap} ref={scrollRef}>
        <table className={`${styles.table} ${virtual ? styles.tableFixed : ""}`}>
          <caption className="visuallyHidden">{meta?.label ?? nav}</caption>
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
        {/* B84: announce the visible row count as it changes with the
            filter/sort — a polite live region, hidden visually. */}
        <span className="visuallyHidden" role="status">
          {`${rows.length} rows`}
        </span>
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
