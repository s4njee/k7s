/**
 * Scale form for Deployments, StatefulSets, etc.
 */

import { useState } from "react";
import styles from "./ActionList.module.css";
import { kubectlCommand } from "../../lib/kubectl";
import { KubectlPreview } from "./KubectlPreview";
import type { KindId, Row } from "../../providers/types";

interface ScaleFormProps {
  kind: KindId;
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

export function ScaleForm({ kind, row, busy, onCancel, onApply }: ScaleFormProps) {
  const [replicas, setReplicas] = useState(() => currentReplicas(row));

  return (
    <div className={styles.menu}>
      <div className={styles.confirm}>
        <div className={styles.confirmText}>Replicas for {row.name}</div>
        <div className={styles.confirmRow} style={{ justifyContent: "center", gap: 10 }}>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => setReplicas((n) => Math.max(0, n - 1))}
            aria-label="decrease replicas"
          >
            −
          </button>
          <span style={{ fontSize: 13, minWidth: 24, textAlign: "center" }}>{replicas}</span>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => setReplicas((n) => n + 1)}
            aria-label="increase replicas"
          >
            +
          </button>
        </div>
        <div className={styles.confirmRow}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.applyBtn}
            disabled={busy}
            onClick={() => onApply(replicas)}
          >
            Apply
          </button>
        </div>
        <KubectlPreview commands={kubectlCommand("scale", kind, [row], { replicas })} />
      </div>
    </div>
  );
}
