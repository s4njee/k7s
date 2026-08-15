/**
 * The Helm release's History table with a per-row rollback action (B81). The
 * current revision (the highest, the one deployed now) gets no action; every
 * older revision can be rolled back to, which writes a new revision the way
 * `helm rollback` does — same shape as a Deployment's ReplicaSets table.
 */

import styles from "../PropertiesTab.module.css";
import { rollbackable } from "../../../lib/rollback";
import { toneColor } from "../../../lib/tone";
import { NavLink } from "./NavLink";
import { HelmRollbackButton, type HelmRollbackRef } from "./HelmRollbackButton";
import { cellText, wraps } from "./propertiesUtils";
import type { Cell } from "../../../providers/types";

export function HelmHistoryTable({
  columns,
  rows,
  now,
  helm,
}: {
  columns: string[];
  rows: Cell[][];
  now: number;
  helm: HelmRollbackRef;
}) {
  // REVISION is the History table's first column (vs the ReplicaSets table's
  // second). Same "highest revision gets no action" rule either way.
  const revisions = rows.map((r) => Number(r[0]?.text)).filter((n) => Number.isFinite(n));

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((h) => (
              <th key={h} className={styles.th}>
                {h}
              </th>
            ))}
            <th className={`${styles.th} ${styles.thAction}`}>ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => {
            const revision = Number(cells[0]?.text);
            const isCurrent = !rollbackable(revisions, revision);
            return (
              <tr key={i}>
                {cells.map((cell, j) => (
                  <td
                    className={[
                      styles.td,
                      j === 0 ? styles.tdName : "",
                      wraps(cell) ? styles.tdWrap : "",
                    ].join(" ")}
                    key={j}
                    style={{ color: toneColor(cell.tone) }}
                  >
                    {cell.nav ? (
                      <NavLink target={cell.nav}>{cellText(cell, now)}</NavLink>
                    ) : (
                      cellText(cell, now)
                    )}
                  </td>
                ))}
                <td className={styles.td}>
                  {isCurrent ? (
                    <span className={styles.rollbackCurrent}>—</span>
                  ) : (
                    <HelmRollbackButton revision={revision} helm={helm} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
