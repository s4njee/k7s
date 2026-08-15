/**
 * A Secret's Data table (B37): lists the keys with a per-row copy button. The
 * button's command decodes and writes the value to the system clipboard entirely
 * in Rust — the webview only ever shows the "copied ✓" flash, never the value.
 */

import { useState } from "react";
import styles from "../PropertiesTab.module.css";
import { getProvider } from "../../../providers";
import { toneColor } from "../../../lib/tone";
import { NavLink } from "./NavLink";
import { cellText, wraps } from "./propertiesUtils";
import type { Cell } from "../../../providers/types";
import { errDisplay } from "../../../lib/errors";

export interface SecretRef {
  namespace: string;
  name: string;
}

export function SecretDataTable({
  columns,
  rows,
  now,
  secret,
}: {
  columns: string[];
  rows: Cell[][];
  now: number;
  secret: SecretRef;
}) {
  // The key that was just copied, for the transient ✓ flash.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const copy = async (key: string) => {
    try {
      await getProvider().copySecretValue(
        { kind: "secrets", namespace: secret.namespace, name: secret.name },
        key,
      );
      // The ✓ is a flash, not a state: revert after a beat so a second copy is
      // as obvious as the first.
      setCopiedKey(key);
      setFlash(null);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 2000);
    } catch (e) {
      setFlash(errDisplay(e));
      setCopiedKey(null);
    }
  };

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
            <th className={`${styles.th} ${styles.thAction}`}>VALUE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => {
            const key = cells[0]?.text ?? "";
            return (
              <tr key={i}>
                {cells.map((cell, j) => (
                  <td
                    className={[styles.td, j === 0 ? styles.tdName : "", wraps(cell) ? styles.tdWrap : ""].join(" ")}
                    key={j}
                    style={{ color: toneColor(cell.tone) }}
                  >
                    {cell.nav ? <NavLink target={cell.nav}>{cellText(cell, now)}</NavLink> : cellText(cell, now)}
                  </td>
                ))}
                <td className={styles.td}>
                  <button
                    className={`${styles.copyButton} ${copiedKey === key ? styles.copyDone : ""}`}
                    onClick={() => void copy(key)}
                    title={`copy the value of ${key} to the clipboard`}
                  >
                    {copiedKey === key ? "copied ✓" : "copy"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {flash && <div className={styles.copyError}>copy failed: {flash}</div>}
    </div>
  );
}
