/**
 * Table toolbar with search/filter input.
 */

import styles from "./ResourceTable.module.css";
import { useStore } from "../../store";

interface TableToolbarProps {
  filterRef: React.RefObject<HTMLInputElement | null>;
  tableFilter: string;
  setTableFilter: (q: string) => void;
}

export function TableToolbar({ filterRef, tableFilter, setTableFilter }: TableToolbarProps) {
  const nav = useStore((s) => s.nav);
  const problemsScope = useStore((s) => s.problemsScope);
  const setProblemsScope = useStore((s) => s.setProblemsScope);

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
      {nav === "problems" && (
        <button
          className={`${styles.scopeToggle} ${problemsScope === "all" ? styles.scopeToggleOn : ""}`}
          onClick={() => setProblemsScope(problemsScope === "all" ? "active" : "all")}
          title="aggregate problems across every connected cluster"
        >
          {problemsScope === "all" ? "all clusters" : "active cluster"}
        </button>
      )}
    </div>
  );
}
