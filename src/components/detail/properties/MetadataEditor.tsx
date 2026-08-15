/**
 * Labels & Annotations editor (B88, v5 B62): inline add/edit/remove of the
 * selected object's metadata via focused JSON Patch — not a full YAML PUT. Long
 * annotation values truncate with expand-on-click; removing a label a
 * Service/PDB/NetworkPolicy selects on warns naming the dependent; Helm-managed
 * metadata is read-only (the backend also rejects the patch).
 *
 * The row is a snapshot, so after a successful patch the editor updates its own
 * copy and bumps the parent's refreshKey — the table reflects the change through
 * the watcher without a manual refresh.
 */

import { useState } from "react";
import styles from "./MetadataEditor.module.css";
import { useStore } from "../../../store";
import { getProvider } from "../../../providers";
import { errDisplay } from "../../../lib/errors";
import type { LabelDependencies } from "../../../providers/types";

interface MetadataEditorProps {
  onChanged: () => void;
}

type Section = "labels" | "annotations";

interface MetadataChange {
  labels?: { add?: Record<string, string>; remove?: string[] };
  annotations?: { add?: Record<string, string>; remove?: string[] };
}

export function MetadataEditor({ onChanged }: MetadataEditorProps) {
  const row = useStore((s) => s.selectedRow);
  const kind = useStore((s) => s.nav);

  const [labels, setLabels] = useState<Record<string, string>>(row?.labels ?? {});
  const [annotations, setAnnotations] = useState<Record<string, string>>(row?.annotations ?? {});
  const [adding, setAdding] = useState<Section | null>(null);
  const [editing, setEditing] = useState<{ section: Section; key: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removalWarning, setRemovalWarning] = useState<{ key: string; deps: LabelDependencies } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!row) return null;

  const helmManaged = (row.labels?.["app.kubernetes.io/managed-by"] ?? "") === "Helm";
  const ref = { kind, namespace: row.namespace, name: row.name };

  const apply = async (change: MetadataChange) => {
    setBusy(true);
    setError(null);
    try {
      await getProvider().patchMetadata(ref, change);
      // Reflect locally (the row is a snapshot); the watcher updates the table.
      if (change.labels) {
        setLabels((m) => {
          const next = { ...m };
          for (const k of change.labels!.remove ?? []) delete next[k];
          Object.assign(next, change.labels!.add ?? {});
          return next;
        });
      }
      if (change.annotations) {
        setAnnotations((m) => {
          const next = { ...m };
          for (const k of change.annotations!.remove ?? []) delete next[k];
          Object.assign(next, change.annotations!.add ?? {});
          return next;
        });
      }
      onChanged();
    } catch (e) {
      setError(errDisplay(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (section: Section, key: string) => {
    // A pod label removal can deselect the pod from a Service/PDB/NetworkPolicy.
    if (section === "labels" && kind === "pods") {
      const deps = await getProvider().labelDependencies(ref, key);
      if (deps.services.length || deps.pdbs.length || deps.networkPolicies.length) {
        setRemovalWarning({ key, deps });
        return;
      }
    }
    await apply(section === "labels" ? { labels: { remove: [key] } } : { annotations: { remove: [key] } });
  };

  const add = async (section: Section) => {
    if (!newKey.trim()) return;
    await apply(
      section === "labels"
        ? { labels: { add: { [newKey.trim()]: newValue } } }
        : { annotations: { add: { [newKey.trim()]: newValue } } },
    );
    setNewKey("");
    setNewValue("");
    setAdding(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    await apply(
      editing.section === "labels"
        ? { labels: { add: { [editing.key]: editValue } } }
        : { annotations: { add: { [editing.key]: editValue } } },
    );
    setEditing(null);
  };

  const section = (title: Section, map: Record<string, string>) => (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {Object.entries(map).map(([key, value]) => (
        <div key={key} className={styles.row}>
          {editing?.section === title && editing.key === key ? (
            <div className={styles.editRow}>
              <span className={styles.key}>{key}</span>
              <input
                className={styles.input}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                aria-label={`edit value of ${key}`}
              />
              <button type="button" className={styles.btn} onClick={() => void saveEdit()} disabled={busy}>
                Save
              </button>
              <button type="button" className={styles.btn} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              <span className={styles.key}>{key}</span>
              <span
                className={styles.value}
                title={value}
                onClick={() => value.length > 40 && setExpanded(expanded === key ? null : key)}
              >
                {expanded === key || value.length <= 40 ? value : `${value.slice(0, 40)}…`}
              </span>
              <button
                type="button"
                className={styles.btn}
                aria-label={`edit ${key}`}
                disabled={busy}
                onClick={() => {
                  setEditing({ section: title, key });
                  setEditValue(value);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className={styles.btn}
                aria-label={`remove ${key}`}
                disabled={busy}
                onClick={() => void remove(title, key)}
              >
                ✕
              </button>
            </>
          )}
        </div>
      ))}
      {adding === title ? (
        <div className={styles.editRow}>
          <input
            className={styles.input}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="key"
            aria-label={`new ${title} key`}
          />
          <input
            className={styles.input}
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="value"
            aria-label={`new ${title} value`}
          />
          <button type="button" className={styles.btn} onClick={() => void add(title)} disabled={busy}>
            Add
          </button>
          <button type="button" className={styles.btn} onClick={() => setAdding(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={styles.addBtn} onClick={() => setAdding(title)}>
          + add {title === "labels" ? "label" : "annotation"}
        </button>
      )}
    </div>
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.heading}>
        Metadata
        {helmManaged && (
          <span className={styles.helmNote}>managed by Helm — change it via `helm upgrade` or the YAML tab</span>
        )}
      </div>
      {removalWarning && (
        <div className={styles.warning} role="alert">
          Removing the label <code>{removalWarning.key}</code> will deselect this pod from:{" "}
          {[...removalWarning.deps.services, ...removalWarning.deps.pdbs, ...removalWarning.deps.networkPolicies].join(", ")}
          <span className={styles.warningActions}>
            <button type="button" className={styles.btn} onClick={() => void apply({ labels: { remove: [removalWarning.key] } })}>
              Remove anyway
            </button>
            <button type="button" className={styles.btn} onClick={() => setRemovalWarning(null)}>
              Keep it
            </button>
          </span>
        </div>
      )}
      {error && <div className={styles.error} role="alert">{error}</div>}
      {section("labels", labels)}
      {section("annotations", annotations)}
    </div>
  );
}
