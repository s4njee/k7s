/**
 * Properties tab (B13, B18): what the selected object is actually wired to.
 *
 * The backend decides both the content and the shape — it returns an ordered list
 * of sections, each a field grid, a table, or chips. This renders that document
 * generically via SectionView.
 */

import { useEffect, useState } from "react";
import styles from "./PropertiesTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useNow } from "../../hooks/useNow";
import { SectionView } from "./properties/SectionView";
import type { Properties } from "../../providers/types";
import { errDisplay } from "../../lib/errors";

export function PropertiesTab() {
  const row = useStore((s) => s.selectedRow);
  const kind = useStore((s) => s.nav);
  const [props, setProps] = useState<Properties | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by a rollout undo so the ReplicaSets table refreshes to the new
  // revision the controller is about to create.
  const [refreshKey, setRefreshKey] = useState(0);
  const now = useNow();

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setProps(null);
    setError(null);
    void getProvider()
      .getProperties({ kind, namespace: row.namespace, name: row.name })
      .then((p) => {
        if (!cancelled) setProps(p);
      })
      .catch((e) => {
        if (!cancelled) setError(errDisplay(e));
      });
    return () => {
      cancelled = true;
    };
  }, [row?.uid, row?.namespace, row?.name, kind, refreshKey]);

  if (error) return <div className={styles.state}>{error}</div>;
  if (!props) return <div className={styles.state}>loading properties…</div>;

  // Only a Deployment's properties carry a ReplicaSets table, so the rollback
  // action (B34b) is keyed on the selected row being a Deployment.
  const rollout =
    kind === "deployments" && row
      ? {
          namespace: row.namespace ?? "",
          name: row.name,
          onChanged: () => setRefreshKey((k) => k + 1),
        }
      : undefined;

  // Only a Secret's properties carry the Data table, so the per-key copy buttons
  // (B37) are keyed on the selected row being a Secret.
  const secretRef =
    kind === "secrets" && row ? { namespace: row.namespace ?? "", name: row.name } : undefined;

  // A Helm release's History table carries the rollback actions (B81), keyed on
  // the selected row being a Helm release.
  const helmRollback =
    kind === "helm" && row
      ? {
          namespace: row.namespace ?? "",
          name: row.name,
          onChanged: () => setRefreshKey((k) => k + 1),
        }
      : undefined;

  return (
    <div className={styles.wrap}>
      {props.sections.map((s) => (
        <SectionView
          key={s.title}
          section={s}
          now={now}
          rollout={rollout}
          secretRef={secretRef}
          helmRollback={helmRollback}
        />
      ))}
    </div>
  );
}
