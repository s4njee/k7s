/**
 * The problems count badge (B32): shown only when something's wrong, toned by
 * the worst severity (red if any critical problem, amber otherwise). Zero
 * problems renders nothing — the "deliberately quiet" state.
 */

import styles from "./Sidebar.module.css";
import type { Row } from "../../providers/types";

export function ProblemsBadge({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  const worst = rows.some((r) => r.cells[0]?.tone === "err") ? "err" : "warn";
  return (
    <span
      className={`${styles.problemBadge} ${
        worst === "err" ? styles.problemBadgeErr : styles.problemBadgeWarn
      }`}
    >
      {rows.length}
    </span>
  );
}
