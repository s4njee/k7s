/**
 * Table header and column group rendering (B87).
 *
 * Renders the B87 rendered-column descriptor (`refs`): a sortable button per
 * column (aria-sort on the active one), a drag-reorder grip for base columns,
 * and a right-edge resize handle that writes a percentage width back to the
 * per-{cid, kind} config. Custom columns are reordered via the column menu's ↑/↓
 * (they have no base order), so they aren't draggable.
 */

import { useRef, useState } from "react";
import styles from "./ResourceTable.module.css";
import { columnWidth } from "./useVirtualRows";
import type { ColumnRef } from "../../lib/columns";

interface TableHeaderProps {
  refs: ColumnRef[];
  sortCol: number | null;
  sortDir: "asc" | "desc";
  toggleSort: (col: number) => void;
  widths?: Record<string, number>;
  onResize?: (name: string, width: number) => void;
  onReorder?: (from: string, to: string) => void;
}

export function TableHeader({
  refs,
  sortCol,
  sortDir,
  toggleSort,
  widths,
  onResize,
  onReorder,
}: TableHeaderProps) {
  const widthFor = (name: string): string =>
    widths?.[name] != null ? `${widths[name]}%` : columnWidth(name);

  return (
    <>
      <colgroup>
        {refs.map((ref) => (
          <col key={ref.name} style={{ width: widthFor(ref.name) }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {refs.map((ref, i) => (
            <HeaderCell
              key={ref.name}
              refMeta={ref}
              index={i}
              sortCol={sortCol}
              sortDir={sortDir}
              toggleSort={toggleSort}
              onResize={onResize}
              onReorder={onReorder}
            />
          ))}
        </tr>
      </thead>
    </>
  );
}

/** One column header: sort button + drag grip (base columns) + resize handle. */
function HeaderCell({
  refMeta,
  index,
  sortCol,
  sortDir,
  toggleSort,
  onResize,
  onReorder,
}: {
  refMeta: ColumnRef;
  index: number;
  sortCol: number | null;
  sortDir: "asc" | "desc";
  toggleSort: (col: number) => void;
  onResize?: (name: string, width: number) => void;
  onReorder?: (from: string, to: string) => void;
}) {
  const isBase = refMeta.baseIndex !== null;
  const [dragging, setDragging] = useState(false);
  const dragName = useRef<string | null>(null);

  // ---- resize (B87): drag the right-edge handle to set a percentage width ----
  const resizeState = useRef<{ startX: number; tablePx: number; colPx: number; name: string } | null>(null);

  const onResizeStart = (e: React.PointerEvent) => {
    if (!onResize) return;
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th");
    const table = th?.closest("table");
    if (!th || !table) return;
    resizeState.current = {
      startX: e.clientX,
      tablePx: table.getBoundingClientRect().width || 1,
      colPx: th.getBoundingClientRect().width,
      name: refMeta.name,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const st = resizeState.current;
    if (!st || !onResize) return;
    const dx = e.clientX - st.startX;
    const newPct = Math.max(5, Math.min(90, ((st.colPx + dx) / st.tablePx) * 100));
    onResize(st.name, newPct);
  };

  const onResizeEnd = (e: React.PointerEvent) => {
    resizeState.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // ---- drag reorder (v5 B67): HTML5 DnD over the header cells ----
  const onDragStart = (e: React.DragEvent) => {
    if (!isBase || !onReorder) {
      e.preventDefault();
      return;
    }
    dragName.current = refMeta.name;
    setDragging(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", refMeta.name);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragName.current;
    setDragging(false);
    dragName.current = null;
    if (from && from !== refMeta.name && onReorder) onReorder(from, refMeta.name);
  };

  return (
    <th
      scope="col"
      className={`${styles.th} ${dragging ? styles.thDragging : ""}`}
      aria-sort={sortCol === index ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
      onDragOver={(e) => isBase && e.preventDefault()}
      onDrop={onDrop}
    >
      <div className={styles.thInner}>
        {isBase && onReorder && (
          <span
            className={styles.thGrip}
            title="drag to reorder"
            aria-hidden="true"
            draggable
            onDragStart={onDragStart}
            onDragEnd={() => {
              setDragging(false);
              dragName.current = null;
            }}
          >
            ⣿
          </span>
        )}
        <button type="button" className={styles.thButton} onClick={() => toggleSort(index)}>
          {refMeta.name}
          {sortCol === index && (
            <span className={styles.sortArrow} aria-hidden="true">
              {sortDir === "asc" ? " ▲" : " ▼"}
            </span>
          )}
        </button>
      </div>
      {onResize && (
        <span
          className={styles.thResize}
          title="resize column"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
        />
      )}
    </th>
  );
}
