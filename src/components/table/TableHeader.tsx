/**
 * Table header and column group rendering.
 */

import styles from "./ResourceTable.module.css";
import { columnWidth } from "./useVirtualRows";

interface TableHeaderProps {
  columns: string[];
  virtual: boolean;
  sortCol: number | null;
  sortDir: "asc" | "desc";
  toggleSort: (col: number) => void;
}

export function TableHeader({
  columns,
  virtual,
  sortCol,
  sortDir,
  toggleSort,
}: TableHeaderProps) {
  return (
    <>
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
    </>
  );
}
