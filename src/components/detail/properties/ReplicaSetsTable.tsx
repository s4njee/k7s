/**
 * The Deployment's ReplicaSets table with a per-row rollback action (B34b).
 * The current revision (the highest, the one being rolled out) gets no action;
 * every older revision can be rolled back to, which copies its pod template back
 * onto the Deployment.
 */

import styles from "../PropertiesTab.module.css";
import { rollbackable } from "../../../lib/rollback";
import { toneColor } from "../../../lib/tone";
import { NavLink } from "./NavLink";
import { RollbackButton, type RolloutRef } from "./RollbackButton";
import { cellText, wraps } from "./propertiesUtils";
import type { Cell } from "../../../providers/types";

export function ReplicaSetsTable({
  columns,
  rows,
  now,
  rollout,
}: {
  columns: string[];
  rows: Cell[][];
  now: number;
  rollout: RolloutRef;
}) {
  const revisions = rows.map((r) => Number(r[1]?.text)).filter((n) => Number.isFinite(n));

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((h) => (
              <th scope="col" key={h} className={styles.th}>
                {h}
              </th>
            ))}
            <th scope="col" className={`${styles.th} ${styles.thAction}`}>ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => {
            const revision = Number(cells[1]?.text);
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
                    <RollbackButton revision={revision} rollout={rollout} />
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
