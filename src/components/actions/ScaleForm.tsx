/**
 * Scale form for Deployments, StatefulSets, etc.
 */

import { useState } from "react";
import styles from "./ActionList.module.css";
import type { Row } from "../../providers/types";

interface ScaleFormProps {
  row: Row;
  busy: boolean;
  onCancel: () => void;
  onApply: (replicas: number) => void;
}

/** Replicas shown as the starting value: the desired count from a "3/3" cell. */
function currentReplicas(row: Row): number {
  for (const cell of row.cells) {
    const m = /^(\d+)\/(\d+)$/.exec(cell.text.trim());
    if (m) return Number(m[2]);
  }
  return 1;
}

export function ScaleForm({ row, busy, onCancel, onApply }: ScaleFormProps) {
  const [replicas, setReplicas] = useState(() => currentReplicas(row));

  return (
    <div className={styles.menu}>
      <div className={styles.confirm}>
        <div className={styles.confirmText}>Replicas for {row.name}</div>
        <div className={styles.confirmRow} style={{ justifyContent: "center", gap: 10 }}>
          <div className={styles.cancelBtn} onClick={() => setReplicas((n) => Math.max(0, n - 1))}>
            −
          </div>
          <span style={{ fontSize: 13, minWidth: 24, textAlign: "center" }}>{replicas}</span>
          <div className={styles.cancelBtn} onClick={() => setReplicas((n) => n + 1)}>
            +
          </div>
        </div>
        <div className={styles.confirmRow}>
          <div className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </div>
          <div
            className={styles.applyBtn}
            aria-disabled={busy}
            onClick={() => onApply(replicas)}
          >
            Apply
          </div>
        </div>
      </div>
    </div>
  );
}
