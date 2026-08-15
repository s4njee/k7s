/**
 * Diff tab (B54): the delta between the live object and its last-applied
 * configuration — what changed since it was last deployed. The backend returns
 * the live YAML and the baseline (from the last-applied annotation, or a
 * managed-fields reconstruction); this renders the hunks with the same DiffView
 * the apply-preview uses.
 */

import { useEffect, useState } from "react";
import styles from "./DiffTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { DiffView } from "./DiffView";
import type { YamlDiff } from "../../providers/types";
import { errDisplay } from "../../lib/errors";

export function DiffTab() {
  const row = useStore((s) => s.selectedRow);
  const kind = useStore((s) => s.nav);
  const [diff, setDiff] = useState<YamlDiff | null>(null);
  const [noBaseline, setNoBaseline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setDiff(null);
    setNoBaseline(false);
    setError(null);
    void getProvider()
      .getDiff({ kind, namespace: row.namespace, name: row.name })
      .then((d) => {
        if (cancelled) return;
        // current = baseline (what was applied), proposed = live — so additions
        // read as "not in what you deployed", matching kubectl's direction.
        if (!d.baseline) {
          setNoBaseline(true);
          return;
        }
        setDiff({ current: d.baseline, proposed: d.live });
      })
      .catch((e) => {
        if (!cancelled) setError(errDisplay(e));
      });
    return () => {
      cancelled = true;
    };
  }, [row?.uid, row?.namespace, row?.name, kind]);

  if (!row) return null;
  if (error) return <div className={styles.state}>{error}</div>;
  if (noBaseline) {
    return (
      <div className={styles.state}>
        no baseline available — this object has neither a last-applied annotation
        nor apply managed-fields to diff against
      </div>
    );
  }
  if (!diff) return <div className={styles.state}>loading diff…</div>;
  return (
    <div className={styles.wrap}>
      <DiffView diff={diff} />
    </div>
  );
}
