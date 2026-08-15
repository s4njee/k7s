/**
 * Table row and cell rendering with tone coloring, status dots, and selection highlights.
 */

import { memo } from "react";
import styles from "./ResourceTable.module.css";
import { formatAge } from "../../lib/format";
import { toneColor } from "../../lib/tone";
import { ROW_HEIGHT } from "./useVirtualRows";
import type { Cell, Row } from "../../providers/types";

interface TableRowProps {
  row: Row;
  index: number;
  virtual: boolean;
  clickable: boolean;
  selected: boolean;
  inSelection: boolean;
  highlight: boolean;
  now: number;
  onSelect: (row: Row, e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, row: Row) => void;
}

/** Render a cell's text: format age timestamps, prefix a status dot when set. */
export function renderCell(cell: Cell, now: number): string {
  const text = cell.format === "age" ? formatAge(cell.text, now) : cell.text;
  return cell.dot ? `● ${text}` : text;
}

export const TableRow = memo(function TableRow({
  row,
  index,
  virtual,
  clickable,
  selected,
  inSelection,
  highlight,
  now,
  onSelect,
  onContextMenu,
}: TableRowProps) {
  return (
    <tr
      data-row-index={index}
      className={[
        styles.row,
        virtual ? styles.rowFixed : "",
        clickable ? styles.rowClickable : "",
        selected ? styles.rowSelected : "",
        inSelection && !selected ? styles.rowInSelection : "",
        highlight ? styles.rowHighlight : "",
      ].join(" ")}
      style={virtual ? { height: ROW_HEIGHT } : undefined}
      onClick={(e) => onSelect(row, e)}
      onContextMenu={(e) => onContextMenu(e, row)}
    >
      {row.cells.map((cell, j) => (
        <td key={j} className={styles.td} style={{ color: toneColor(cell.tone) }}>
          {renderCell(cell, now)}
        </td>
      ))}
    </tr>
  );
});
