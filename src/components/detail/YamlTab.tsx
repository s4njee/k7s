/**
 * YAML tab (Design §4-YAML). Fetches the pod's YAML, shows it read-only with
 * syntax highlighting, and supports Edit → Apply (PUT to the cluster) with inline
 * API-error reporting. Cancel discards the draft.
 */

import { useEffect, useState } from "react";
import styles from "./YamlTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { CodeEditor } from "./CodeEditor";
import { DiffView } from "./DiffView";
import type { ResourceRef, YamlDiff } from "../../providers/types";
import { errDisplay } from "../../lib/errors";

export function YamlTab() {
  const row = useStore((s) => s.selectedRow);
  // The selected row's kind is the current nav kind (selection clears on nav change).
  const kind = useStore((s) => s.nav);
  const yamlEditing = useStore((s) => s.yamlEditing);
  const yamlDraft = useStore((s) => s.yamlDraft);
  const startYamlEdit = useStore((s) => s.startYamlEdit);
  const cancelYaml = useStore((s) => s.cancelYaml);
  const setYamlDraft = useStore((s) => s.setYamlDraft);

  const [yamlText, setYamlText] = useState("");
  // Bumped after each fetch so the read-only editor remounts with fresh content.
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // The server's answer to "what would this actually do" (B36). Non-null puts
  // the tab in review mode: the real apply is only reachable from here.
  const [review, setReview] = useState<YamlDiff | null>(null);

  const ref: ResourceRef | null = row
    ? { kind, namespace: row.namespace, name: row.name }
    : null;

  // Fetch YAML on selection change (and on first open of this tab).
  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    void getProvider()
      .getYaml(ref)
      .then((text) => {
        if (cancelled) return;
        setYamlText(text);
        setNonce((n) => n + 1);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(errDisplay(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.uid, row?.namespace, row?.name]);

  if (!row || !ref) return null;

  // Secret values are redacted server-side, so editing is disabled for them.
  const editable = kind !== "secrets";
  // Namespaced → "kind/ns/name.yaml"; cluster-scoped → "kind/name.yaml".
  const path = row.namespace
    ? `${kind}/${row.namespace}/${row.name}.yaml`
    : `${kind}/${row.name}.yaml`;

  /**
   * Step one of applying (B36): ask the server what the edit would do, without
   * writing. A rejection here is the admission chain refusing the manifest —
   * shown inline, draft kept, cluster untouched.
   */
  const onPreview = async () => {
    setApplying(true);
    try {
      setReview(await getProvider().dryRunYaml(ref, yamlDraft));
      setError(null);
    } catch (e) {
      setError(errDisplay(e));
    } finally {
      setApplying(false);
    }
  };

  const onApply = async () => {
    setApplying(true);
    try {
      await getProvider().applyYaml(ref, yamlDraft);
      setReview(null);
      cancelYaml(); // leave edit mode
      // Refetch to reflect the server's canonical version.
      const text = await getProvider().getYaml(ref);
      setYamlText(text);
      setNonce((n) => n + 1);
      setError(null);
    } catch (e) {
      // Keep the draft and surface the API error inline (Story 5.4).
      setError(errDisplay(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.path}>{path}</span>
        <span className={styles.spacer} />
        {yamlEditing ? (
          review ? (
            <>
              <button type="button" className={styles.cancelBtn} onClick={() => setReview(null)}>
                Back to editing
              </button>
              <button
                type="button"
                className={styles.applyBtn}
                disabled={applying}
                onClick={() => void onApply()}
              >
                Apply for real
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => {
                  setReview(null);
                  cancelYaml();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.applyBtn}
                disabled={applying}
                onClick={() => void onPreview()}
              >
                {applying ? "Checking…" : "Preview changes ⏎"}
              </button>
            </>
          )
        ) : (
          editable && (
            <button
              type="button"
              className={styles.editBtn}
              onClick={() => {
                setError(null);
                startYamlEdit(yamlText);
              }}
            >
              ✎ Edit
            </button>
          )
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {yamlEditing && review ? (
        <DiffView
          diff={review}
          note="as the server would store it, after defaulting and any mutating webhooks"
          empty="No changes — the server would store this object exactly as it is now."
        />
      ) : yamlEditing ? (
        <div className={`${styles.editorWrap} ${styles.editing}`}>
          <CodeEditor
            key={`edit:${row.uid}`}
            value={yamlText}
            editable
            fontFamily="var(--font-yaml)"
            onChange={setYamlDraft}
          />
        </div>
      ) : (
        <div className={styles.editorWrap}>
          <CodeEditor
            key={`read:${row.uid}:${nonce}`}
            value={yamlText}
            editable={false}
            fontFamily="var(--font-yaml)"
          />
        </div>
      )}
    </>
  );
}
