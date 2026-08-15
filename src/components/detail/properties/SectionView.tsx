/**
 * One section: header (with a row count for tables) plus its body.
 */

import styles from "../PropertiesTab.module.css";
import { FieldRow } from "./FieldRow";
import { NavLink } from "./NavLink";
import { ReplicaSetsTable } from "./ReplicaSetsTable";
import { SecretDataTable, type SecretRef } from "./SecretDataTable";
import { type RolloutRef } from "./RollbackButton";
import { cellText, wraps } from "./propertiesUtils";
import { toneColor } from "../../../lib/tone";
import type { Section } from "../../../providers/types";

export function SectionView({
  section,
  now,
  rollout,
  secretRef,
}: {
  section: Section;
  now: number;
  rollout?: RolloutRef;
  secretRef?: SecretRef;
}) {
  const { body } = section;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        {section.title}
        {/* Counts belong on lists, not on the Overview grid or chip groups. */}
        {body.type === "table" && ` (${body.rows.length})`}
      </div>

      {body.type === "fields" && (
        <div className={styles.grid}>
          {body.fields.map((f) => (
            <FieldRow key={f.label} field={f} now={now} />
          ))}
        </div>
      )}

      {body.type === "table" &&
        (body.rows.length === 0 ? (
          <div className={styles.empty}>{section.emptyNote}</div>
        ) : section.title === "ReplicaSets" && rollout ? (
          // B34b: the Deployment's ReplicaSets table gets a per-row rollback
          // action for every revision except the one being rolled out.
          <ReplicaSetsTable columns={body.columns} rows={body.rows} now={now} rollout={rollout} />
        ) : section.title === "Data" && secretRef ? (
          // B37: a Secret's Data table lists keys; each gets a copy button whose
          // command decodes the value in Rust so it never enters the webview.
          <SecretDataTable columns={body.columns} rows={body.rows} now={now} secret={secretRef} />
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {body.columns.map((h) => (
                    <th key={h} className={styles.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.rows.map((cells, i) => (
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {body.type === "chips" && (
        <div className={styles.chips}>
          {body.chips.map((kv) => (
            <span key={kv.key} className={styles.chip} title={`${kv.key}=${kv.value}`}>
              <span className={styles.chipKey}>{kv.key}</span>
              <span className={styles.chipVal}>{kv.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
