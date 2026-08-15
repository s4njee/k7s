/**
 * A collapsible "kubectl equivalent" section with a copy button (B88, v5 B64):
 * the exact command the action maps to, constructed from its parameters. Bulk
 * actions show one command per resource. Placed at the foot of every mutation
 * confirmation and the scale/port-forward forms.
 */

import { useState } from "react";
import styles from "./KubectlPreview.module.css";
import { copyText } from "../../lib/kubectl";

export function KubectlPreview({ commands, note }: { commands: string[]; note?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (commands.length === 0) return null;

  const copy = async () => {
    await copyText(commands.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={styles.preview}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} kubectl equivalent
      </button>
      {open && (
        <div className={styles.body}>
          {note && <div className={styles.note}>{note}</div>}
          <pre className={styles.command}>{commands.join("\n")}</pre>
          <button type="button" className={styles.copy} onClick={() => void copy()}>
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
      )}
    </div>
  );
}
