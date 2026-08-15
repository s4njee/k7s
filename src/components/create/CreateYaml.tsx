/**
 * Create-from-YAML modal (B36): paste or edit a manifest in the CodeMirror
 * editor, dry-run it against the server (defaulting + any mutating webhooks
 * applied), then create it. The manifest's apiVersion/kind select the resource
 * and metadata.namespace (or the current filter) places it; a successful create
 * navigates to the new object.
 */

import { useEffect, useState } from "react";
import styles from "./CreateYaml.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { CodeEditor } from "../detail/CodeEditor";

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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} onClick={() => setOpen(false)}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Create from YAML</span>
          <span className={styles.close} title="close" onClick={() => setOpen(false)}>
            ×
          </span>
        </div>

        <div className={styles.toolbar}>
          <span className={styles.ns}>namespace: {namespace}</span>
          <span className={styles.spacer} />
          {proposed ? (
            <div className={styles.previewBtn} onClick={() => setProposed(null)}>
              Back to editing
            </div>
          ) : (
            <div className={styles.previewBtn} aria-disabled={busy} onClick={() => void preview()}>
              {busy ? "Checking…" : "Preview ⏎"}
            </div>
          )}
          <div className={styles.createBtn} aria-disabled={busy} onClick={() => void create()}>
            {busy ? "…" : "Create"}
          </div>
        </div>

        {error && <div className={styles.error}>{error}</div>}

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
