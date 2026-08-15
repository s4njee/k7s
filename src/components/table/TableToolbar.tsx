/**
 * Table toolbar with search/filter input.
 */

import styles from "./ResourceTable.module.css";

interface TableToolbarProps {
  filterRef: React.RefObject<HTMLInputElement | null>;
  tableFilter: string;
  setTableFilter: (q: string) => void;
}

export function TableToolbar({ filterRef, tableFilter, setTableFilter }: TableToolbarProps) {
  return (
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
  );
}
