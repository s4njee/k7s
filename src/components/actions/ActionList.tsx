/**
 * The actions menu contents (B39) — shared by the detail panel's "…" button and
 * the table's row context menu.
 *
 * This is the *whole* menu: the item list, the confirmations, and the two
 * parameterised forms (scale, port-forward). Everything the two surfaces disagree
 * about is left outside — only positioning, which genuinely differs (anchored
 * under a button vs. at the mouse cursor).
 *
 * Splitting it any other way was the trap. If the row menu kept its own copy of
 * the forms, it would quietly not offer Scale on a Deployment, and the two menus
 * would answer "what can I do to this object" differently depending on how you
 * opened them. Which actions exist is decided in one place (lib/actions.ts) and
 * rendered in one place (here).
 */

import { useState } from "react";
import styles from "./ActionList.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { selectorFilter } from "../../lib/filter";
import {
  actionsFor,
  bulkErrorText,
  confirmText,
  isRolloutKind,
  plural,
  runBulk,
  type ActionDef,
  type ActionId,
} from "../../lib/actions";
import type { KindId, ResourceRef, Row } from "../../providers/types";

interface ActionListProps {
  kind: KindId;
  /** What the actions apply to. One row behaves exactly as it always did. */
  rows: Row[];
  /** Report an API error (or null to clear). */
  onError: (msg: string | null) => void;
  /** Close the menu. */
  onClose: () => void;
  /**
   * Called when the acted-on objects are gone (deleted, or a pod restarted into a
   * new name), so the caller can drop a selection that no longer refers to
   * anything. Distinct from onClose: a scale or a cordon leaves the object there.
   */
  onGone: () => void;
}

type Mode = { kind: "menu" } | { kind: "confirm"; id: ActionId } | { kind: "form"; id: ActionId };

/** Replicas shown as the starting value: the desired count from a "3/3" cell. */
function currentReplicas(row: Row): number {
  for (const cell of row.cells) {
    const m = /^(\d+)\/(\d+)$/.exec(cell.text.trim());
    if (m) return Number(m[2]);
  }
  return 1;
}

/** A sensible default port: the service's first, else the usual HTTP guess. */
function defaultPort(row: Row, kind: KindId): number {
  if (kind === "services") {
    for (const cell of row.cells) {
      const m = /(\d{2,5})/.exec(cell.text);
      if (m) return Number(m[1]);
    }
  }
  return 8080;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable — the forward still works, it just isn't copied */
  }
}

export function ActionList({ kind, rows, onError, onClose, onGone }: ActionListProps) {
  const setPortForwards = useStore((s) => s.setPortForwards);
  const viewPods = useStore((s) => s.viewPods);

  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const [busy, setBusy] = useState(false);
  const [replicas, setReplicas] = useState(() => currentReplicas(rows[0] ?? { cells: [] } as never));
  const [port, setPort] = useState(() =>
    rows[0] ? defaultPort(rows[0], kind) : 8080,
  );

  const actions = actionsFor(kind, rows);
  if (actions.length === 0) return null;

  const single = rows[0];
  const refOf = (row: Row): ResourceRef => ({ kind, namespace: row.namespace, name: row.name });

  /** Execute an action, then close (or report). `gone` means the objects are no more. */
  async function execute(fn: (row: Row) => Promise<void>, gone: boolean) {
    setBusy(true);
    onError(null);
    try {
      const outcome = await runBulk(rows, fn);
      const err = bulkErrorText(outcome);
      onError(err);
      // Anything that worked is gone even if something else failed, so the
      // selection must still be dropped — leaving it would point at deleted rows.
      if (gone && outcome.ok > 0) onGone();
      if (!err) onClose();
      else setMode({ kind: "menu" });
    } finally {
      setBusy(false);
    }
  }

  /** Click on a menu item: run it, ask first, or open its form. */
  function pick(action: ActionDef) {
    if (action.mode !== "immediate") {
      setMode({ kind: action.mode === "confirm" ? "confirm" : "form", id: action.id });
      return;
    }
    switch (action.id) {
      case "cordon":
        void execute((row) => getProvider().setCordon(row.name, true), false);
        break;
      case "uncordon":
        void execute((row) => getProvider().setCordon(row.name, false), false);
        break;
      case "view-pods":
        // Navigation, not a mutation: drop the selector into the filter box as
        // editable text rather than a hidden mode the user can't get out of.
        viewPods(single.namespace, selectorFilter(single.selector ?? {}));
        onClose();
        break;
    }
  }

  /** Run a confirmed action. */
  function confirmed(id: ActionId) {
    switch (id) {
      case "delete":
        void execute((row) => getProvider().deleteResource(refOf(row)), true);
        break;
      case "restart":
        // A restarted pod is deleted and recreated under a new name, so it's gone
        // from this table; a rolled workload keeps its identity.
        void execute(
          (row) =>
            isRolloutKind(kind)
              ? getProvider().restartRollout(refOf(row))
              : getProvider().restartPod(refOf(row)),
          !isRolloutKind(kind),
        );
        break;
      case "drain":
        // Resolves once cordoned; the eviction progress streams to the banner.
        void execute((row) => getProvider().drainNode(row.name), false);
        break;
    }
  }

  // ---- confirmations ----
  if (mode.kind === "confirm") {
    const danger = actions.find((a) => a.id === mode.id)?.danger;
    return (
      <div className={styles.menu}>
        <div className={styles.confirm}>
          <div className={styles.confirmText}>{confirmText(mode.id, kind, rows)}</div>
          <div className={styles.confirmRow}>
            <div className={styles.cancelBtn} onClick={() => setMode({ kind: "menu" })}>
              Cancel
            </div>
            <div
              className={danger ? styles.dangerBtn : styles.applyBtn}
              aria-disabled={busy}
              onClick={() => confirmed(mode.id)}
            >
              {busy ? "…" : label(mode.id)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- scale ----
  if (mode.kind === "form" && mode.id === "scale") {
    return (
      <div className={styles.menu}>
        <div className={styles.confirm}>
          <div className={styles.confirmText}>Replicas for {single.name}</div>
          <div className={styles.confirmRow} style={{ justifyContent: "center", gap: 10 }}>
            <div className={styles.cancelBtn} onClick={() => setReplicas((n) => Math.max(0, n - 1))}>
              −
            </div>
            <span style={{ fontSize: 13, minWidth: 24, textAlign: "center" }}>{replicas}</span>
            <div className={styles.cancelBtn} onClick={() => setReplicas((n) => n + 1)}>
              +
            </div>
          </div>
          <div className={styles.confirmRow}>
            <div className={styles.cancelBtn} onClick={() => setMode({ kind: "menu" })}>
              Cancel
            </div>
            <div
              className={styles.applyBtn}
              aria-disabled={busy}
              onClick={() =>
                void execute((row) => getProvider().scaleResource(refOf(row), replicas), false)
              }
            >
              Apply
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- port-forward ----
  if (mode.kind === "form" && mode.id === "forward") {
    return (
      <div className={styles.menu}>
        <div className={styles.confirm}>
          <div className={styles.confirmText}>
            {kind === "services" ? "Forward service port" : "Forward pod port"}
          </div>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            style={{
              background: "var(--bg-terminal)",
              border: "1px solid var(--border-control)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-body)",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              padding: "4px 8px",
            }}
          />
          <div className={styles.confirmRow}>
            <div className={styles.cancelBtn} onClick={() => setMode({ kind: "menu" })}>
              Cancel
            </div>
            <div
              className={styles.applyBtn}
              aria-disabled={busy}
              onClick={() =>
                void execute(async (row) => {
                  const fwd = await getProvider().startPortForward(refOf(row), port);
                  setPortForwards(await getProvider().listPortForwards());
                  await copyToClipboard(`localhost:${fwd.localPort}`);
                }, false)
              }
            >
              Forward
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- the menu ----
  const safe = actions.filter((a) => !a.danger);
  const dangerous = actions.filter((a) => a.danger);

  return (
    <div className={styles.menu}>
      {rows.length > 1 && (
        <div className={styles.scope}>
          {rows.length} {plural(kind, rows.length)} selected
        </div>
      )}
      {safe.map((a) => (
        <div key={a.id} className={styles.row} onClick={() => pick(a)}>
          {a.label}
        </div>
      ))}
      {safe.length > 0 && dangerous.length > 0 && <div className={styles.separator} />}
      {dangerous.map((a) => (
        <div key={a.id} className={`${styles.row} ${styles.danger}`} onClick={() => pick(a)}>
          {a.label}
        </div>
      ))}
    </div>
  );
}

/** The confirm button's verb — the menu label minus its trailing ellipsis. */
function label(id: ActionId): string {
  switch (id) {
    case "delete":
      return "Delete";
    case "restart":
      return "Restart";
    case "drain":
      return "Drain";
    default:
      return "Confirm";
  }
}
