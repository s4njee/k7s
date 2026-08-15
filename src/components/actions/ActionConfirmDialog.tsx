/**
 * Confirmation dialog for destructive actions in the actions menu.
 */

import styles from "./ActionList.module.css";
import { confirmText, type ActionDef, type ActionId } from "../../lib/actions";
import type { KindId, Row } from "../../providers/types";

interface ActionConfirmDialogProps {
  id: ActionId;
  kind: KindId;
  rows: Row[];
  actions: ActionDef[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (id: ActionId) => void;
}

export function ActionConfirmDialog({
  id,
  kind,
  rows,
  actions,
  busy,
  onCancel,
  onConfirm,
}: ActionConfirmDialogProps) {
  const danger = actions.find((a) => a.id === id)?.danger;

  return (
    <div className={styles.menu}>
      <div className={styles.confirm}>
        <div className={styles.confirmText}>{confirmText(id, kind, rows)}</div>
        <div className={styles.confirmRow}>
          <div className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </div>
          <div
            className={danger ? styles.dangerBtn : styles.applyBtn}
            aria-disabled={busy}
            onClick={() => onConfirm(id)}
          >
            {busy ? "…" : label(id)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The confirm button's verb — the menu label minus its trailing ellipsis. */
function label(id: ActionId): string {
  switch (id) {
    case "delete":
      return "Delete";
    case "restart":
      return "Restart";
    case "drain":
      return "Drain";
    case "suspend":
      return "Suspend";
    case "resume":
      return "Resume";
    case "run-now":
      return "Run now";
    case "retry":
      return "Retry";
    default:
      return "Confirm";
  }
}
