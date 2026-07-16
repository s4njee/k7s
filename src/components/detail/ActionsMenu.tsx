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

type Mode = "menu" | "confirmDelete" | "scale" | "forward" | "confirmDrain";

export function ActionsMenu({ kind, row, onError, onDeleted }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [replicas, setReplicas] = useState(() => currentReplicas(row));
  const [port, setPort] = useState(() => defaultPort(row, kind));
  const [busy, setBusy] = useState(false);
  const setPortForwards = useStore((s) => s.setPortForwards);

  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => close(), open);

  // Which actions apply to this kind.
  // Helm releases are read-only (B26): deleting the row would mean deleting a
  // release's storage Secret behind Helm's back, which is not uninstalling it —
  // it's corrupting it. `helm uninstall` is the only right way to do that.
  const canDelete = kind !== "nodes" && kind !== "namespaces" && kind !== "helm";
  const canScale = kind === "deployments" || kind === "statefulsets";
  const canCordon = kind === "nodes";
  // Services forward via a resolved backing pod (B16).
  const isService = kind === "services";
  const canForward = kind === "pods" || isService;
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
          setPort(defaultPort(row, kind));
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
                  {/* Evicts every pod on the node — confirmed, and marked danger. */}
                  <div
                    className={`${styles.actionsRow} ${styles.actionsDanger}`}
                    onClick={() => setMode("confirmDrain")}
                  >
                    Drain…
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

          {mode === "confirmDrain" && (
            <div className={styles.actionsConfirm}>
              <div className={styles.actionsConfirmText}>
                Drain {row.name}? This cordons it and evicts every pod on it
                (DaemonSet and static pods stay).
              </div>
              <div className={styles.actionsConfirmRow}>
                <div className={styles.cancelBtn} onClick={() => setMode("menu")}>
                  Cancel
                </div>
                <div
                  className={styles.deleteBtn}
                  aria-disabled={busy}
                  onClick={() => run(() => getProvider().drainNode(row.name), close)}
                >
                  Drain
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
              <div className={styles.actionsConfirmText}>
                {isService ? "Forward service port" : "Forward pod port"}
              </div>
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
                      const fwd = await getProvider().startPortForward(ref3, port);
                      setPortForwards(await getProvider().listPortForwards());
                      // The address is the whole point of starting a forward, so
                      // put it on the clipboard rather than making the user
                      // transcribe an OS-assigned port from the strip.
                      await copyToClipboard(`localhost:${fwd.localPort}`);
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

/**
 * Port to pre-fill the forward dialog with. For a Service, its first published
 * port (read off the PORTS column, e.g. "8080/TCP" or "80/TCP, 443/TCP") — that's
 * almost always the one wanted, and guessing wrong just means an error. Pods have
 * no port column to read, so they keep the 8080 default.
 */
function defaultPort(row: Row, kind: KindId): number {
  if (kind !== "services") return 8080;
  // Services columns: NAME, NAMESPACE, TYPE, CLUSTER-IP, PORTS(4), AGE.
  const m = /(\d+)/.exec(row.cells[4]?.text ?? "");
  return m ? parseInt(m[1], 10) : 8080;
}

/**
 * Copy text to the clipboard, ignoring failure — a forward that started is still
 * useful (the address is shown in the strip) even if the clipboard is unavailable.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Non-fatal; the strip still shows the address.
  }
}
