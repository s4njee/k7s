/**
 * Create-from-YAML modal (B36): paste or edit a manifest in the CodeMirror
 * editor, dry-run it against the server (defaulting + any mutating webhooks
 * applied), then create it. The manifest's apiVersion/kind select the resource
 * and metadata.namespace (or the current filter) places it; a successful create
 * navigates to the new object.
 */

import { useEffect, useRef, useState } from "react";
import styles from "./CreateYaml.module.css";
import { useStore } from "../../store";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { getProvider } from "../../providers";
import { CodeEditor } from "../detail/CodeEditor";
import { KubectlPreview } from "../actions/KubectlPreview";
import { errDisplay } from "../../lib/errors";

/** A starter manifest, so an empty editor never greets anyone. */
const EXAMPLE = `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  key: value
`;

export function CreateYaml() {
  const open = useStore((s) => s.createOpen);
  const setOpen = useStore((s) => s.setCreateOpen);
  const namespace = useStore((s) => s.namespace);
  const navigateTo = useStore((s) => s.navigateTo);
  const [draft, setDraft] = useState(EXAMPLE);
  // The server's answer to "what would this actually store", for the preview.
  const [proposed, setProposed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Esc closes; opening resets the draft and the preview.
  useEffect(() => {
    if (!open) return;
    setDraft(EXAMPLE);
    setProposed(null);
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // B84: trap Tab in the dialog and return focus to the opener on close.
  // Declared before the `open` early return so the hook order is stable.
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  if (!open) return null;

  // The current filter is the default namespace; "all" means the manifest's own
  // metadata.namespace decides.
  const ns = namespace === "all" ? "" : namespace;

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await getProvider().createResource(draft, ns, true);
      setProposed(out.proposed);
    } catch (e) {
      setError(errDisplay(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await getProvider().createResource(draft, ns, false);
      setOpen(false);
      if (out.created) navigateTo(out.created);
    } catch (e) {
      setError(errDisplay(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={styles.backdrop}
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-yaml-title"
    >
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} ref={dialogRef}>
        <div className={styles.header}>
          <span className={styles.title} id="create-yaml-title">
            Create from YAML
          </span>
          <button
            type="button"
            className={styles.close}
            title="close"
            aria-label="close create dialog"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>

        <div className={styles.toolbar}>
          <span className={styles.ns}>namespace: {namespace}</span>
          <span className={styles.spacer} />
          {proposed ? (
            <button type="button" className={styles.previewBtn} onClick={() => setProposed(null)}>
              Back to editing
            </button>
          ) : (
            <button
              type="button"
              className={styles.previewBtn}
              disabled={busy}
              onClick={() => void preview()}
            >
              {busy ? "Checking…" : "Preview ⏎"}
            </button>
          )}
          <button
            type="button"
            className={styles.createBtn}
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? "…" : "Create"}
          </button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        {/* B88/v5 B64: the kubectl equivalent of a YAML create. */}
        <KubectlPreview commands={["kubectl apply -f -"]} note="pipes the manifest to kubectl — the same object this dialog creates" />

        {proposed ? (
          <div className={styles.editor}>
            <CodeEditor value={proposed} editable={false} fontFamily="var(--font-yaml)" />
          </div>
        ) : (
          <div className={styles.editor}>
            <CodeEditor value={draft} editable onChange={setDraft} fontFamily="var(--font-yaml)" />
          </div>
        )}

        <div className={styles.hint}>
          {proposed
            ? "This is what the server would store, after defaulting and any mutating webhooks."
            : "The manifest's kind and namespace come from the YAML; Preview runs it past the server before you create."}
        </div>
      </div>
    </div>
  );
}
