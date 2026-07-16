/**
 * Properties tab (B13, B18): what the selected object is actually wired to.
 *
 * The backend decides both the content and the shape — it returns an ordered list
 * of sections, each a field grid, a table, or chips (see
 * src-tauri/src/kube/properties.rs). This renders that document generically, so a
 * pod's containers/volumes/services and a node's taints/capacity go through the
 * same code and adding a kind needs no change here.
 *
 * Fetched in one backend call on open / selection change.
 */

import { useEffect, useState } from "react";
import styles from "./PropertiesTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useNow } from "../../hooks/useNow";
import { formatAge } from "../../lib/format";
import { toneColor } from "../../lib/tone";
import type { Cell, Properties, Section } from "../../providers/types";

export function PropertiesTab() {
  const row = useStore((s) => s.selectedRow);
  const kind = useStore((s) => s.nav);
  const [props, setProps] = useState<Properties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setProps(null);
    setError(null);
    void getProvider()
      .getProperties({ kind, namespace: row.namespace, name: row.name })
      .then((p) => {
        if (!cancelled) setProps(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [row?.uid, row?.namespace, row?.name, kind]);

  if (error) return <div className={styles.state}>{error}</div>;
  if (!props) return <div className={styles.state}>loading properties…</div>;

  return (
    <div className={styles.wrap}>
      {props.sections.map((s) => (
        <SectionView key={s.title} section={s} now={now} />
      ))}
    </div>
  );
}

/** One section: header (with a row count for tables) plus its body. */
function SectionView({ section, now }: { section: Section; now: number }) {
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
            <FieldRow key={f.label} label={f.label} value={f.value} now={now} />
          ))}
        </div>
      )}

      {body.type === "table" &&
        (body.rows.length === 0 ? (
          <div className={styles.empty}>{section.emptyNote}</div>
        ) : (
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
                      // The first column is the row's name; later ones may hold
                      // long text (images, messages) that should wrap.
                      className={`${styles.td} ${j === 0 ? styles.tdName : styles.tdWrap}`}
                      key={j}
                      style={{ color: toneColor(cell.tone) }}
                    >
                      {cellText(cell, now)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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

/** One key/value row in a field grid. */
function FieldRow({ label, value, now }: { label: string; value: Cell; now: number }) {
  return (
    <>
      <span className={styles.gridKey}>{label}</span>
      <span className={styles.gridVal} style={{ color: toneColor(value.tone) }}>
        {cellText(value, now)}
      </span>
    </>
  );
}

/** Cell text, formatting age cells like the resource tables do. */
function cellText(cell: Cell, now: number): string {
  return cell.format === "age" ? formatAge(cell.text, now) : cell.text;
}
