/**
 * Table toolbar with search/filter input and saved views (B60).
 *
 * "▾ views" opens a dropdown of built-in views + this cluster's saved views; each
 * applies on click (nav + namespace + filter + sort + scope in one update).
 * "Save current view…" captures the current table state into a named, persisted
 * view. The dropdown mirrors the app's other menus (in-place, click-outside to
 * close).
 */

import { useRef, useState } from "react";
import styles from "./ResourceTable.module.css";
import { useStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import { kindMeta } from "../../lib/kinds";
import { BUILTIN_VIEWS, type SavedView } from "../../lib/views";

interface TableToolbarProps {
  filterRef: React.RefObject<HTMLInputElement | null>;
  tableFilter: string;
  setTableFilter: (q: string) => void;
}

/** Stable empty list so the saved-views selector never returns a fresh ref. */
const EMPTY_VIEWS: SavedView[] = [];

export function TableToolbar({ filterRef, tableFilter, setTableFilter }: TableToolbarProps) {
  const nav = useStore((s) => s.nav);
  const namespace = useStore((s) => s.namespace);
  const problemsScope = useStore((s) => s.problemsScope);
  const setProblemsScope = useStore((s) => s.setProblemsScope);
  const sortCol = useStore((s) => s.sortCol);
  const sortDir = useStore((s) => s.sortDir);
  const customKinds = useStore((s) => s.customKinds);
  const activeCid = useStore((s) => s.activeCid);
  const savedViews = useStore((s) => (s.activeCid ? s.savedViewsByCid[s.activeCid] ?? EMPTY_VIEWS : EMPTY_VIEWS));
  const addSavedView = useStore((s) => s.addSavedView);
  const removeSavedView = useStore((s) => s.removeSavedView);
  const applyView = useStore((s) => s.applyView);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(wrapRef, () => setOpen(false), open);

  // The columns the table renders for the current kind + scope — mirrors
  // ResourceTable (CLUSTER prepended for all-clusters problems), so the store's
  // numeric sortCol maps to a stable column NAME for the saved view.
  const columns = kindMeta(nav, customKinds)?.columns ?? [];
  const rendered = nav === "problems" && problemsScope === "all" ? ["CLUSTER", ...columns] : columns;

  const views = [...BUILTIN_VIEWS, ...savedViews];

  /** Capture the current table state as a view and save it for this cluster. */
  const save = () => {
    if (!name.trim() || !activeCid) return;
    const view: SavedView = {
      id: name, // addSavedView re-slugs the id from the name
      name: name.trim(),
      kind: nav,
      namespace,
      filter: tableFilter,
      sortColName: sortCol != null ? (rendered[sortCol] ?? null) : null,
      sortDir,
      ...(nav === "problems" ? { problemsScope } : {}),
      columns, // B87 forward-compat: the visible column set at save time
    };
    addSavedView(activeCid, view);
    setSaving(false);
    setName("");
    setOpen(false);
  };

  return (
    <div className={styles.toolbar}>
      <div className={styles.search}>
        <span className={styles.searchIcon} aria-hidden="true">⌕</span>
        <input
          ref={filterRef}
          className={styles.searchInput}
          value={tableFilter}
          onChange={(e) => setTableFilter(e.target.value)}
          placeholder="filter…"
          data-table-filter
        />
      </div>

      <div className={styles.viewWrap} ref={wrapRef}>
        <button
          type="button"
          className={styles.viewsBtn}
          onClick={() => {
            setOpen((o) => !o);
            setSaving(false);
          }}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          ▾ views
        </button>

        {open && (
          <div className={styles.viewMenu} role="menu" aria-label="saved views">
            {saving ? (
              <div className={styles.saveRow}>
                <input
                  className={styles.saveInput}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="view name"
                  aria-label="view name"
                  autoFocus
                />
                <button type="button" className={styles.saveBtn} onClick={save}>
                  Save
                </button>
                <button
                  type="button"
                  className={styles.saveBtn}
                  onClick={() => {
                    setSaving(false);
                    setName("");
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                {views.map((v) => (
                  <div key={v.id} className={styles.viewRow}>
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.viewItem}
                      onClick={() => {
                        setOpen(false);
                        applyView(v);
                      }}
                    >
                      {v.name}
                      {v.builtin && <span className={styles.builtinTag}>built-in</span>}
                    </button>
                    {!v.builtin && activeCid && (
                      <button
                        type="button"
                        className={styles.viewDelete}
                        aria-label={`delete view ${v.name}`}
                        onClick={() => removeSavedView(activeCid, v.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {views.length > 0 && <div className={styles.viewDivider} />}
                <button
                  type="button"
                  role="menuitem"
                  className={styles.viewItem}
                  onClick={() => setSaving(true)}
                >
                  Save current view…
                </button>
              </>
            )}
          </div>
        )}
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
