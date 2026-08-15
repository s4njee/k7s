/**
 * The Helm History section's "roll back to revision N…" action (B81): a button
 * that unfolds a red confirm naming the revision, then rolls the release back
 * and refreshes the properties — the same affordance a Deployment's ReplicaSets
 * table has, for the release whose incident is being handled.
 */

import { useState } from "react";
import styles from "../PropertiesTab.module.css";
import { getProvider } from "../../../providers";
import { errDisplay } from "../../../lib/errors";

export interface HelmRollbackRef {
  namespace: string;
  name: string;
  onChanged: () => void;
}

export function HelmRollbackButton({ revision, helm }: { revision: number; helm: HelmRollbackRef }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doRollback = async () => {
    setBusy(true);
    setError(null);
    try {
      await getProvider().rollbackRelease(
        { kind: "helm", namespace: helm.namespace, name: helm.name },
        revision,
      );
      // The refresh re-fetches properties — the History now shows the new
      // revision the rollback wrote, and this row's target becomes superseded.
      helm.onChanged();
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
