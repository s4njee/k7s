/**
 * Actions menu (B3) for the detail header: a "⋯" button opening a dropdown of
 * kind-appropriate mutations — Delete (with inline confirm), Scale (Deployments/
 * StatefulSets), and Cordon/Uncordon (Nodes). API errors are reported to the
 * parent for inline display. Renders nothing for kinds with no actions.
 */

import { useRef, useState } from "react";
import styles from "./DetailPanel.module.css";
import { getProvider } from "../../providers";
import { useStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import type { KindId, Row } from "../../providers/types";

interface ActionsMenuProps {
  kind: KindId;
  row: Row;
  /** Report an API error (or null to clear) for the header banner. */
  onError: (msg: string | null) => void;
  /** Called after a successful delete so the panel can close. */
  onDeleted: () => void;
}

type Mode = "menu" | "confirmDelete" | "scale" | "forward";

export function ActionsMenu({ kind, row, onError, onDeleted }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [replicas, setReplicas] = useState(() => currentReplicas(row));
  const [port, setPort] = useState(8080);
  const [busy, setBusy] = useState(false);
  const setPortForwards = useStore((s) => s.setPortForwards);

  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => close(), open);

  // Which actions apply to this kind.
  const canDelete = kind !== "nodes" && kind !== "namespaces";
  const canScale = kind === "deployments" || kind === "statefulsets";
  const canCordon = kind === "nodes";
  const canForward = kind === "pods";
  if (!canDelete && !canScale && !canCordon && !canForward) return null;

  function close() {
    setOpen(false);
    setMode("menu");
  }

  /** Run an action, surfacing errors and closing on success. */
  async function run(fn: () => Promise<void>, afterSuccess: () => void) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      afterSuccess();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ref3: { kind: KindId; namespace?: string; name: string } = {
    kind,
    namespace: row.namespace,
    name: row.name,
  };

  return (
    <div className={styles.actionsWrap} ref={ref}>
      <div
        className={styles.actionsButton}
        title="actions"
        onClick={() => {
          setReplicas(currentReplicas(row));
          setMode("menu");
          setOpen((o) => !o);
        }}
      >
        ⋯
      </div>

      {open && (
        <div className={styles.actionsMenu}>
          {mode === "menu" && (
            <>
              {canForward && (
                <div className={styles.actionsRow} onClick={() => setMode("forward")}>
                  Forward…
                </div>
              )}
              {canScale && (
                <div className={styles.actionsRow} onClick={() => setMode("scale")}>
                  Scale…
                </div>
              )}
              {canCordon && (
                <>
                  <div
                    className={styles.actionsRow}
                    onClick={() => run(() => getProvider().setCordon(row.name, true), close)}
                  >
                    Cordon
                  </div>
                  <div
                    className={styles.actionsRow}
                    onClick={() => run(() => getProvider().setCordon(row.name, false), close)}
                  >
                    Uncordon
                  </div>
                </>
              )}
              {canDelete && (
                <div
                  className={`${styles.actionsRow} ${styles.actionsDanger}`}
                  onClick={() => setMode("confirmDelete")}
                >
                  Delete…
                </div>
              )}
            </>
          )}

          {mode === "confirmDelete" && (
            <div className={styles.actionsConfirm}>
              <div className={styles.actionsConfirmText}>Delete {row.name}?</div>
              <div className={styles.actionsConfirmRow}>
                <div className={styles.cancelBtn} onClick={() => setMode("menu")}>
                  Cancel
                </div>
                <div
                  className={styles.deleteBtn}
                  aria-disabled={busy}
                  onClick={() =>
                    run(() => getProvider().deleteResource(ref3), () => {
                      close();
                      onDeleted();
                    })
                  }
                >
                  Delete
                </div>
              </div>
            </div>
          )}

          {mode === "scale" && (
            <div className={styles.actionsConfirm}>
              <div className={styles.actionsConfirmText}>Replicas</div>
              <div className={styles.scaleRow}>
                <div
                  className={styles.stepBtn}
                  onClick={() => setReplicas((n) => Math.max(0, n - 1))}
                >
                  −
                </div>
                <span className={styles.scaleValue}>{replicas}</span>
                <div className={styles.stepBtn} onClick={() => setReplicas((n) => n + 1)}>
                  +
                </div>
              </div>
              <div className={styles.actionsConfirmRow}>
                <div className={styles.cancelBtn} onClick={() => setMode("menu")}>
                  Cancel
                </div>
                <div
                  className={styles.applyBtn}
                  aria-disabled={busy}
                  onClick={() =>
                    run(() => getProvider().scaleResource(ref3, replicas), close)
                  }
                >
                  Apply
                </div>
              </div>
            </div>
          )}

          {mode === "forward" && (
            <div className={styles.actionsConfirm}>
              <div className={styles.actionsConfirmText}>Forward pod port</div>
              <input
                className={styles.portInput}
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
              <div className={styles.actionsConfirmRow}>
                <div className={styles.cancelBtn} onClick={() => setMode("menu")}>
                  Cancel
                </div>
                <div
                  className={styles.applyBtn}
                  aria-disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await getProvider().startPortForward(ref3, port);
                      setPortForwards(await getProvider().listPortForwards());
                    }, close)
                  }
                >
                  Forward
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Best-effort current replica count from the row's "a/b" READY cell (else 1). */
function currentReplicas(row: Row): number {
  for (const cell of row.cells) {
    const m = /^(\d+)\/(\d+)$/.exec(cell.text);
    if (m) return parseInt(m[2], 10); // desired = denominator
  }
  return 1;
}
