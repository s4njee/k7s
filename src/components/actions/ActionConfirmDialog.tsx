/**
 * Confirmation dialog for destructive actions in the actions menu.
 *
 * For a drain, the dialog also shows the PDB preview (B61/B80): what would be
 * evicted and which PodDisruptionBudgets would block it, so a drain that would
 * stall is visible *before* committing rather than surfacing as a 429 mid-drain.
 */

import { useEffect, useState } from "react";
import styles from "./ActionList.module.css";
import { confirmText, type ActionDef, type ActionId } from "../../lib/actions";
import { getProvider } from "../../providers";
import type { DrainPreview, KindId, Row } from "../../providers/types";

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
  const [preview, setPreview] = useState<DrainPreview | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [uninstallObjects, setUninstallObjects] = useState<{ kind: string; name: string }[] | null>(null);
  const [uninstallError, setUninstallError] = useState(false);

  // Fetch the PDB math when a single-node drain is being confirmed. Keyed on the
  // node's name, not the rows array, so a background watch tick doesn't re-fetch
  // and flash the loading state.
  useEffect(() => {
    if (id !== "drain" || rows.length !== 1) return;
    let live = true;
    setPreview(null);
    setPreviewError(false);
    getProvider()
      .drainPreview(rows[0].name)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {
        // A restricted cluster can't always list PDBs; the confirm still works.
        if (live) setPreviewError(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rows[0]?.name]);

  // An uninstall removes the objects its chart installed — enumerate them in the
  // confirm (B81 accept: "confirm enumerating them first"), from the release's
  // own Objects properties section.
  useEffect(() => {
    if (id !== "uninstall" || rows.length !== 1) return;
    let live = true;
    setUninstallObjects(null);
    setUninstallError(false);
    getProvider()
      .getProperties({ kind, namespace: rows[0].namespace, name: rows[0].name })
      .then((p) => {
        if (!live) return;
        const obj = p.sections.find((s) => s.title === "Objects");
        if (obj && obj.body.type === "table") {
          setUninstallObjects(
            obj.body.rows.map((r) => ({ kind: r[0]?.text ?? "", name: r[1]?.text ?? "" })),
          );
        } else {
          setUninstallObjects([]);
        }
      })
      .catch(() => {
        // Properties are best-effort; the confirm still works without the list.
        if (live) setUninstallError(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rows[0]?.name]);

  return (
    <div className={styles.menu}>
      <div className={styles.confirm}>
        <div className={styles.confirmText}>{confirmText(id, kind, rows)}</div>
        {id === "drain" && !preview && !previewError && (
          <div className={styles.drainPreviewLoading}>checking PodDisruptionBudgets…</div>
        )}
        {id === "drain" && preview && preview.pdbs.length > 0 && (
          <div className={styles.drainPreview}>
            <div className={styles.drainPreviewTitle}>
              {preview.podCount} evictable pod{preview.podCount === 1 ? "" : "s"} on this node
            </div>
            <table>
              <thead>
                <tr>
                  <th>PDB</th>
                  <th>MIN AVAILABLE</th>
                  <th>CURRENT HEALTHY</th>
                  <th>DISRUPTIONS ALLOWED</th>
                </tr>
              </thead>
              <tbody>
                {preview.pdbs.map((p) => (
                  <tr key={`${p.namespace}/${p.name}`}>
                    <td>
                      {p.namespace}/{p.name}
                    </td>
                    <td>{p.minAvailable}</td>
                    <td>{p.currentHealthy}</td>
                    <td
                      className={p.disruptionsAllowed === 0 ? styles.pdbBlocked : undefined}
                      title={
                        p.disruptionsAllowed === 0
                          ? "No pod under this budget can be evicted right now."
                          : undefined
                      }
                    >
                      {p.disruptionsAllowed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {id === "drain" && previewError && (
          <div className={styles.drainPreviewError}>couldn't check PodDisruptionBudgets</div>
        )}
        {id === "uninstall" && !uninstallObjects && !uninstallError && (
          <div className={styles.drainPreviewLoading}>listing the objects it installed…</div>
        )}
        {id === "uninstall" && uninstallObjects && uninstallObjects.length > 0 && (
          <div className={styles.drainPreview}>
            <div className={styles.drainPreviewTitle}>
              Deletes {uninstallObjects.length} object{uninstallObjects.length === 1 ? "" : "s"}:
            </div>
            <table>
              <thead>
                <tr>
                  <th>KIND</th>
                  <th>NAME</th>
                </tr>
              </thead>
              <tbody>
                {uninstallObjects.map((o) => (
                  <tr key={`${o.kind}/${o.name}`}>
                    <td>{o.kind}</td>
                    <td>{o.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {id === "uninstall" && uninstallError && (
          <div className={styles.drainPreviewError}>couldn't list the objects it installed</div>
        )}
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
    case "uninstall":
      return "Uninstall";
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
