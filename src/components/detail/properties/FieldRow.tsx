/**
 * One key/value row in a field grid. A field with a nav target (B33) renders as
 * a click-through link (e.g. a pod's owner → its Deployment).
 */

import styles from "../PropertiesTab.module.css";
import { toneColor } from "../../../lib/tone";
import { NavLink } from "./NavLink";
import { cellText } from "./propertiesUtils";
import type { Field } from "../../../providers/types";

export function FieldRow({ field, now }: { field: Field; now: number }) {
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
