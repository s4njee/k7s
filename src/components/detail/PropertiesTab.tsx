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
import type { Cell, Field, NavTarget, Properties, Section } from "../../providers/types";

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
            <FieldRow key={f.label} field={f} now={now} />
          ))}
        </div>
      )}

      {body.type === "table" &&
        (body.rows.length === 0 ? (
          <div className={styles.empty}>{section.emptyNote}</div>
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

/**
 * A reference to another object, rendered as a click-through link (B33, B40).
 * Inherits the surrounding colour so a linked status keeps its tone; the
 * underline is what marks it navigable.
 */
function NavLink({ target, children }: { target: NavTarget; children: React.ReactNode }) {
  const navigateTo = useStore((s) => s.navigateTo);
  return (
    <button
      type="button"
      className={styles.navLink}
      title={`Go to ${target.kind} ${target.name}`}
      onClick={() => navigateTo(target)}
    >
      {children}
    </button>
  );
}

/** One key/value row in a field grid. A field with a nav target (B33) renders as
 * a click-through link (e.g. a pod's owner → its Deployment). */
function FieldRow({ field, now }: { field: Field; now: number }) {
  const { label, value, nav } = field;
  const color = toneColor(value.tone);
  return (
    <>
      <span className={styles.gridKey}>{label}</span>
      <span className={styles.gridVal} style={{ color }}>
        {nav ? <NavLink target={nav}>{cellText(value, now)}</NavLink> : cellText(value, now)}
      </span>
    </>
  );
}

/** Cell text, formatting age cells like the resource tables do. */
function cellText(cell: Cell, now: number): string {
  return cell.format === "age" ? formatAge(cell.text, now) : cell.text;
}

/**
 * Length past which a value is allowed to wrap instead of holding the column open.
 * Sized to sit above the values that should stay on one line ("100m / 1",
 * "8080/TCP", "ReadWriteOnce") and below the ones that shouldn't hold a column
 * open (images, PV names, mount paths, condition messages).
 */
const WRAP_AT = 24;

/**
 * Whether a cell may wrap. Decided by the value, not the column: the renderer is
 * generic, so it can't know that column 2 is an image here and a phase there —
 * but it can see that "registry.freya.io/valkyrie-api:2.14.0" needs to wrap and
 * "Running" does not. Wrapping short values would let them break mid-token.
 */
function wraps(cell: Cell): boolean {
  // Ages are rendered short ("4d2h") whatever the timestamp's length.
  if (cell.format === "age") return false;
  return cell.text.length > WRAP_AT;
}
