/**
 * Port forward form for services and pods.
 */

import { useState } from "react";
import styles from "./ActionList.module.css";
import type { KindId, Row } from "../../providers/types";

interface PortForwardFormProps {
  kind: KindId;
  row: Row;
  busy: boolean;
  onCancel: () => void;
  onForward: (port: number) => void;
}

/** A sensible default port: the service's first, else the usual HTTP guess. */
function defaultPort(row: Row, kind: KindId): number {
  if (kind === "services") {
    for (const cell of row.cells) {
      const m = /(\d{2,5})/.exec(cell.text);
      if (m) return Number(m[1]);
    }
  }
  return 8080;
}

export function PortForwardForm({ kind, row, busy, onCancel, onForward }: PortForwardFormProps) {
  const [port, setPort] = useState(() => defaultPort(row, kind));

  return (
    <div className={styles.menu}>
      <div className={styles.confirm}>
        <div className={styles.confirmText}>
          {kind === "services" ? "Forward service port" : "Forward pod port"}
        </div>
        <input
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
          style={{
            background: "var(--bg-terminal)",
            border: "1px solid var(--border-control)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-body)",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            padding: "4px 8px",
          }}
        />
        <div className={styles.confirmRow}>
          <div className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </div>
          <div
            className={styles.applyBtn}
            aria-disabled={busy}
            onClick={() => onForward(port)}
          >
            Forward
          </div>
        </div>
      </div>
    </div>
  );
}
