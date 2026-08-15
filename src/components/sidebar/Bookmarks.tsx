/**
 * Bookmarks section (B56): the resources a user wants one click away, below the
 * cluster switcher. Each shows the kind's icon + name with a live status dot
 * pulled from the store rows (no new watchers) — a bookmark whose resource has
 * been deleted shows a muted "not found" and revives when it's recreated.
 */

import { useState } from "react";
import styles from "./Sidebar.module.css";
import { useStore, rowsFor } from "../../store";
import { bookmarkKey, EMPTY_BOOKMARKS, type Bookmark } from "../../lib/bookmarks";
import { kindMeta } from "../../lib/kinds";
import { toneColor } from "../../lib/tone";
import type { Row, Tone } from "../../providers/types";

/** The live semantic tone of a row, for the bookmark's status dot. */
export function statusToneOf(row: Row): Tone | undefined {
  for (const cell of row.cells) {
    if (cell.tone === "ok" || cell.tone === "warn" || cell.tone === "err") return cell.tone;
  }
  return undefined;
}

export function Bookmarks() {
  const context = useStore((s) => s.connection.context ?? "");
  const bookmarks = useStore((s) => s.bookmarksByContext[context] ?? EMPTY_BOOKMARKS);
  const rows = useStore((s) => s.rows);
  const customKinds = useStore((s) => s.customKinds);
  const navigateTo = useStore((s) => s.navigateTo);
  const [expanded, setExpanded] = useState(true);

  if (bookmarks.length === 0) return null;

  return (
    <div className={styles.bookmarks}>
      <button
        type="button"
        className={styles.bookmarksHeader}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className={styles.navGroupChevron} aria-hidden="true">{expanded ? "⌄" : "›"}</span>
        <span className={styles.bookmarksTitle}>Bookmarks</span>
        <span className={styles.navCount}>{bookmarks.length}</span>
      </button>
      {expanded && (
        <div>
          {bookmarks.map((b) => (
            <BookmarkRow
              key={bookmarkKey(b)}
              bookmark={b}
              icon={kindMeta(b.kind, customKinds)?.icon}
              rows={rows}
              onNavigate={navigateTo}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BookmarkRow({
  bookmark,
  icon,
  rows,
  onNavigate,
}: {
  bookmark: Bookmark;
  icon: string | undefined;
  rows: ReturnType<typeof useStore.getState>["rows"];
  onNavigate: (target: { kind: string; namespace?: string; name: string }) => void;
}) {
  // The live row for this bookmark, when it still exists — the tone comes from it.
  const live = rowsFor(rows, bookmark.kind).find(
    (r) => r.name === bookmark.name && (!bookmark.namespace || r.namespace === bookmark.namespace),
  );
  const tone = live ? statusToneOf(live) : undefined;
  const stale = !live;

  return (
    <button
      type="button"
      className={`${styles.navItem} ${styles.navItemNested}`}
      title={bookmark.namespace ? `${bookmark.kind} · ${bookmark.namespace}/${bookmark.name}` : bookmark.kind}
      onClick={() => onNavigate({ kind: bookmark.kind, namespace: bookmark.namespace, name: bookmark.name })}
    >
      <span className={styles.navIcon} aria-hidden="true">{icon ?? "◈"}</span>
      <span className={styles.navLabel}>{bookmark.name}</span>
      <span
        className={styles.bookmarkStatus}
        style={{ color: stale ? "var(--text-faint)" : tone ? toneColor(tone) : "var(--text-faint)" }}
        aria-hidden="true"
      >
        {stale ? "✕" : "●"}
      </span>
    </button>
  );
}
