/**
 * The "Roll back to revision N…" action: a button that unfolds a red confirm
 * naming the revision, then runs the undo and refreshes the properties.
 */

import { useState } from "react";
import styles from "../PropertiesTab.module.css";
import { getProvider } from "../../../providers";
import { errDisplay } from "../../../lib/errors";

export interface RolloutRef {
  namespace: string;
  name: string;
  onChanged: () => void;
}

export function RollbackButton({ revision, rollout }: { revision: number; rollout: RolloutRef }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doRollback = async () => {
    setBusy(true);
    setError(null);
    try {
      await getProvider().undoRollout(
        { kind: "deployments", namespace: rollout.namespace, name: rollout.name },
        revision,
      );
      // The refresh re-fetches properties, which unmounts this button — the
      // table now shows the controller's new revision in progress.
      rollout.onChanged();
    } catch (e) {
      setError(errDisplay(e));
      setBusy(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <span className={styles.rollbackConfirm}>
        <span className={styles.rollbackQuestion}>Roll back to revision {revision}?</span>
        <button className={styles.rollbackGo} onClick={doRollback} disabled={busy}>
          {busy ? "…" : "roll back"}
        </button>
        <button className={styles.rollbackCancel} onClick={() => setConfirming(false)}>
          cancel
        </button>
        {error && <span className={styles.rollbackError}>{error}</span>}
      </span>
    );
  }

  return (
    <button className={styles.rollback} onClick={() => setConfirming(true)}>
      roll back to rev {revision}…
    </button>
  );
}
