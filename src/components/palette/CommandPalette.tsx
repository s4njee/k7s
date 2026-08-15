/**
 * Command palette (B28) — ⌘K, or `:` in the k9s idiom.
 *
 * One box that reaches anything: a kind, an object, or an app command. It reads
 * only rows the store already has, so it never waits on the network — the list
 * is instant, and what isn't loaded honestly isn't offered (jumping to a CRD kind
 * is what starts its watcher, exactly as clicking the sidebar does).
 *
 * The ranking and the result list are pure functions in lib/palette.ts and
 * lib/fuzzy.ts; this file is the shell around them: focus, keys, and dispatch.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./CommandPalette.module.css";
import { useStore } from "../../store";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { getProvider } from "../../providers";
import { buildPalette, type ActionId, type PaletteItem } from "../../lib/palette";
import { bookmarkKey, EMPTY_BOOKMARKS } from "../../lib/bookmarks";
import { BUILTIN_VIEWS } from "../../lib/views";

const EMPTY_ITEMS: PaletteItem[] = [];

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const jumpTo = useStore((s) => s.jumpTo);
  const rows = useStore((s) => s.rows);
  const customKinds = useStore((s) => s.customKinds);
  const nav = useStore((s) => s.nav);
  const selectedRow = useStore((s) => s.selectedRow);
  const context = useStore((s) => s.connection.context ?? "");
  const bookmarks = useStore((s) => s.bookmarksByContext[context] ?? EMPTY_BOOKMARKS);
  const activeCid = useStore((s) => s.activeCid);
  const savedViewsByCid = useStore((s) => s.savedViewsByCid);
  const applyView = useStore((s) => s.applyView);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () =>
      open
        ? buildPalette(query, {
            rows,
            customKinds,
            nav,
            selectedRow,
            bookmarks: new Set(bookmarks.map(bookmarkKey)),
            // Saved views, with the built-ins always available (B60).
            savedViews: [
              ...BUILTIN_VIEWS,
              ...(activeCid ? savedViewsByCid[activeCid] ?? [] : []),
            ],
          })
        : EMPTY_ITEMS,
    [open, query, rows, customKinds, nav, selectedRow, bookmarks, activeCid, savedViewsByCid],
  );

  // A fresh palette every time: the last query is rarely the next one, and
  // reopening onto stale text means deleting it first.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      inputRef.current?.focus();
    }
  }, [open]);

  // The list reorders as you type, so a cursor from the previous query can point
  // past the end.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Keep the cursor on screen while paging through with the keyboard.
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // B84: trap Tab in the palette, keep focus on its own input, and return focus
  // to whatever ⌘K / ":" was pressed from on close. Declared before the `open`
  // early return so the hook order is stable.
  const paletteRef = useRef<HTMLDivElement>(null);
  useFocusTrap(paletteRef, open, inputRef);

  if (!open) return null;

  const run = (item: PaletteItem) => {
    switch (item.type) {
      case "kind":
        jumpTo(item.id);
        break;
      case "object":
        // Atomic: nav + namespace + selection in one update (see store.jumpTo).
        jumpTo(item.kind, item.row);
        break;
      case "action":
        runAction(item.id);
        setOpen(false);
        break;
      case "view":
        // B60: applying a view navigates (nav/namespace/filter/sort/scope).
        applyView(item.view);
        setOpen(false);
        break;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        // Stop the app-level Esc cascade from also firing and clearing the
        // filter or closing the detail panel behind the palette.
        e.stopPropagation();
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setCursor((c) => Math.min(items.length - 1, c + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (items[cursor]) run(items[cursor]);
        break;
      // j/k move the cursor everywhere else in the app, but here they're just
      // letters — you're typing a name, and a name can contain a j.
    }
  };

  return (
    <div
      className={styles.backdrop}
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="command palette"
    >
      <div className={styles.palette} onClick={(e) => e.stopPropagation()}>
        <div className={styles.inputRow}>
          <span className={styles.prompt} aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            id="palette-input"
            className={styles.input}
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="palette-listbox"
            aria-label="command palette search"
            aria-activedescendant={items.length > 0 ? `palette-option-${cursor}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="go to a kind, an object, or a command…    ns:prod to scope"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* B84: announce the result set as the query changes (polite live region). */}
        <span className="visuallyHidden" role="status">
          {items.length === 0
            ? query
              ? "nothing matches"
              : "type to search"
            : `${items.length} result${items.length === 1 ? "" : "s"}`}
        </span>

        {items.length === 0 ? (
          <div className={styles.empty}>
            {query ? "nothing matches" : "type to search"}
          </div>
        ) : (
          <div className={styles.list} ref={listRef} role="listbox" id="palette-listbox" aria-label="results">
            {items.map((item, i) => (
              <div
                key={itemKey(item)}
                data-i={i}
                role="option"
                id={`palette-option-${i}`}
                aria-selected={i === cursor}
                className={`${styles.item} ${i === cursor ? styles.itemActive : ""}`}
                // Mouse and keyboard drive the same cursor, so hovering then
                // pressing Enter does what the highlight says it will.
                onMouseMove={() => setCursor(i)}
                onClick={() => run(item)}
              >
                <span className={styles.icon} aria-hidden="true">{iconFor(item)}</span>
                <span className={styles.label}>
                  <Highlight text={item.label} indices={item.indices} />
                </span>
                <span className={styles.hint}>{item.hint}</span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.footer}>
          <span>↑↓ move</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

/** Run an app command. Kept here rather than in the item so lib/palette stays pure. */
function runAction(id: ActionId) {
  const s = useStore.getState();
  switch (id) {
    case "settings":
      s.setSettingsOpen(true);
      break;
    case "import-kubeconfig":
      void getProvider()
        .importKubeconfig()
        .then((result) => {
          if (!result) return; // cancelled
          s.setContexts(result.contexts);
          s.addImportedFile(result.path);
        })
        .catch((e) => console.warn("import failed:", e));
      break;
    case "cordon":
    case "uncordon":
      if (s.selectedRow) {
        void getProvider()
          .setCordon(s.selectedRow.name, id === "cordon")
          .catch((e) => console.warn(`${id} failed:`, e));
      }
      break;
  }
}

/** Bold the characters the query matched, so ranking is legible rather than magic. */
function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const hit = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        hit.has(i) ? (
          <span key={i} className={styles.match}>
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/** A key that's stable across queries, so React reuses rows as the list reorders. */
function itemKey(item: PaletteItem): string {
  switch (item.type) {
    case "kind":
      return `kind:${item.id}`;
    case "object":
      return `obj:${item.row.uid}`;
    case "action":
      return `act:${item.id}`;
    case "view":
      return `view:${item.view.id}`;
  }
}

/** Glyph per result, matching the sidebar's vocabulary. */
function iconFor(item: PaletteItem): string {
  switch (item.type) {
    case "kind":
      return item.icon;
    case "object":
      return "›";
    case "action":
      return "⚡";
    case "view":
      return "▾";
  }
}
