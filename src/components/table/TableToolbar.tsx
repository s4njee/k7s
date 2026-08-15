/**
 * Table toolbar: filter input, saved views (B60), the column-config menu (B87:
 * show/hide, reorder via ↑/↓ for keyboard users, custom label/annotation/
 * jsonpath columns, reset), and CSV export of the current logical result.
 */

import { useRef, useState } from "react";
import styles from "./ResourceTable.module.css";
import { useStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import { getProvider } from "../../providers";
import { kindMeta } from "../../lib/kinds";
import { errDisplay } from "../../lib/errors";
import { buildCsv } from "../../lib/csv";
import { BUILTIN_VIEWS, type SavedView } from "../../lib/views";
import {
  EMPTY_COLUMN_PREFS,
  addCustomColumnPrefs,
  customColumnId,
  moveColumnPrefs,
  moveCustomColumnPrefs,
  removeCustomColumnPrefs,
  toggleColumnPrefs,
  type ColumnPrefs,
  type CustomColumn,
  type DisplayRow,
} from "../../lib/columns";

interface TableToolbarProps {
  filterRef: React.RefObject<HTMLInputElement | null>;
  tableFilter: string;
  setTableFilter: (q: string) => void;
  /** The rendered display rows (the logical result) for CSV export (B87). */
  rows: DisplayRow[];
  /** The RENDERED column names — what the table actually shows (B87). */
  columns: string[];
}

/** Stable empty list so the saved-views selector never returns a fresh ref. */
const EMPTY_VIEWS: SavedView[] = [];

export function TableToolbar({ filterRef, tableFilter, setTableFilter, rows, columns }: TableToolbarProps) {
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
  const columnPrefs = useStore((s) => (s.activeCid ? s.columnPrefsByCid[s.activeCid]?.[nav] : undefined));
  const setColumnPrefs = useStore((s) => s.setColumnPrefs);
  const resetColumnPrefs = useStore((s) => s.resetColumnPrefs);

  const [open, setOpen] = useState<"none" | "views" | "columns">("none");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const [customType, setCustomType] = useState<"label" | "annotation" | "jsonpath">("label");
  const [customKey, setCustomKey] = useState("");
  const [customName, setCustomName] = useState("");
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(wrapRef, () => setOpen("none"), open !== "none");

  // The base columns the config applies to (CLUSTER is pinned and not listed).
  const baseColumns = kindMeta(nav, customKinds)?.columns ?? [];
  const views = [...BUILTIN_VIEWS, ...savedViews];

  /** Write a transformed column config back for this {cid, kind} (B87). */
  const write = (patch: (p: ColumnPrefs) => ColumnPrefs) => {
    if (!activeCid) return;
    setColumnPrefs(activeCid, nav, patch(columnPrefs ?? EMPTY_COLUMN_PREFS));
  };

  /** Capture the current table state as a view and save it for this cluster. */
  const save = () => {
    if (!name.trim() || !activeCid) return;
    const view: SavedView = {
      id: name,
      name: name.trim(),
      kind: nav,
      namespace,
      filter: tableFilter,
      // sortCol is a RENDERED index; `columns` is the rendered names (B87).
      sortColName: sortCol != null ? (columns[sortCol] ?? null) : null,
      sortDir,
      ...(nav === "problems" ? { problemsScope } : {}),
      columns: baseColumns,
    };
    addSavedView(activeCid, view);
    setSaving(false);
    setName("");
    setOpen("none");
  };

  const addCustom = () => {
    if (!customKey.trim()) return;
    const col: CustomColumn =
      customType === "jsonpath"
        ? { id: "", type: "jsonpath", name: customName.trim() || customKey.trim(), path: customKey.trim() }
        : { id: "", type: customType, name: customName.trim() || customKey.trim(), key: customKey.trim() };
    write((p) => addCustomColumnPrefs(p, { ...col, id: customColumnId(col) }));
    setAddingCustom(false);
    setCustomKey("");
    setCustomName("");
  };

  const exportCsv = async () => {
    if (rows.length === 0) return;
    const csv = buildCsv(columns, rows.map((d) => d.cells));
    const filename = `${nav}-${namespace === "all" ? "all" : namespace}-${Date.now()}.csv`;
    setSaveNote("saving…");
    try {
      const result = await getProvider().saveCsv(filename, csv);
      setSaveNote(result ? `saved ${result.lines} lines` : null); // null = cancelled
    } catch (e) {
      setSaveNote(`save failed: ${errDisplay(e)}`);
    }
  };

  return (
    // The ref covers the whole toolbar so a click inside it (on either dropdown
    // button, the filter, or export) never trips the click-outside close.
    <div className={styles.toolbar} ref={wrapRef}>
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

      <div className={styles.viewWrap}>
        <button
          type="button"
          className={styles.viewsBtn}
          onClick={() => setOpen(open === "views" ? "none" : "views")}
          aria-haspopup="menu"
          aria-expanded={open === "views"}
        >
          ▾ views
        </button>

        {open === "views" && (
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
                <button type="button" className={styles.saveBtn} onClick={() => { setSaving(false); setName(""); }}>
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
                      onClick={() => { setOpen("none"); applyView(v); }}
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
                <button type="button" role="menuitem" className={styles.viewItem} onClick={() => setSaving(true)}>
                  Save current view…
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Column config (B87). */}
      <div className={styles.viewWrap}>
        <button
          type="button"
          className={styles.viewsBtn}
          onClick={() => setOpen(open === "columns" ? "none" : "columns")}
          aria-haspopup="menu"
          aria-expanded={open === "columns"}
          aria-label="columns"
        >
          ☰ columns
        </button>

        {open === "columns" && (
          <div className={styles.viewMenu} role="menu" aria-label="column configuration">
            {addingCustom ? (
              <div className={styles.colForm}>
                <select
                  className={styles.saveInput}
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value as typeof customType)}
                  aria-label="custom column type"
                >
                  <option value="label">label</option>
                  <option value="annotation">annotation</option>
                  <option value="jsonpath">jsonpath</option>
                </select>
                <input
                  className={styles.saveInput}
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder={customType === "jsonpath" ? "path, e.g. .labels.app" : "label key"}
                  aria-label="key or path"
                />
                <input
                  className={styles.saveInput}
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="display name (optional)"
                  aria-label="display name"
                />
                <div className={styles.saveRow}>
                  <button type="button" className={styles.saveBtn} onClick={addCustom}>Add</button>
                  <button type="button" className={styles.saveBtn} onClick={() => setAddingCustom(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                {baseColumns.map((col) => {
                  const hidden = columnPrefs?.hidden.includes(col) ?? false;
                  return (
                    <div key={col} className={styles.colRow}>
                      <label className={styles.colToggle}>
                        <input type="checkbox" checked={!hidden} onChange={() => write((p) => toggleColumnPrefs(p, col))} />
                        <span>{col}</span>
                      </label>
                      <span className={styles.colButtons}>
                        <button type="button" className={styles.colMove} aria-label={`move ${col} up`} onClick={() => write((p) => moveColumnPrefs(p, col, -1))}>↑</button>
                        <button type="button" className={styles.colMove} aria-label={`move ${col} down`} onClick={() => write((p) => moveColumnPrefs(p, col, 1))}>↓</button>
                      </span>
                    </div>
                  );
                })}
                {columnPrefs?.custom.map((c) => (
                  <div key={c.id} className={styles.colRow}>
                    <span className={styles.colToggle}>
                      <span className={styles.colName}>
                        {c.name} <span className={styles.builtinTag}>{c.type}</span>
                      </span>
                    </span>
                    <span className={styles.colButtons}>
                      <button type="button" className={styles.colMove} aria-label={`move ${c.name} up`} onClick={() => write((p) => moveCustomColumnPrefs(p, c.id, -1))}>↑</button>
                      <button type="button" className={styles.colMove} aria-label={`move ${c.name} down`} onClick={() => write((p) => moveCustomColumnPrefs(p, c.id, 1))}>↓</button>
                      <button type="button" className={styles.viewDelete} aria-label={`remove ${c.name}`} onClick={() => write((p) => removeCustomColumnPrefs(p, c.id))}>✕</button>
                    </span>
                  </div>
                ))}
                <div className={styles.viewDivider} />
                <button type="button" role="menuitem" className={styles.viewItem} onClick={() => setAddingCustom(true)}>
                  Add custom column…
                </button>
                {activeCid && (
                  <button type="button" role="menuitem" className={styles.viewItem} onClick={() => resetColumnPrefs(activeCid, nav)}>
                    Reset to defaults
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <button type="button" className={styles.viewsBtn} onClick={() => void exportCsv()} title="export the filtered result as CSV">
        ⇩ CSV
      </button>
      {saveNote && (
        <span className={styles.saveNote} role="status">{saveNote}</span>
      )}

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
