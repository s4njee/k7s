/**
 * The actions menu contents (B39) — shared by the detail panel's "…" button and
 * the table's row context menu.
 *
 * This is the *whole* menu: the item list, the confirmations, and the two
 * parameterised forms (scale, port-forward). Which actions exist is decided in
 * lib/actions.ts and rendered here.
 */

import { useState } from "react";
import styles from "./ActionList.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { selectorFilter } from "../../lib/filter";
import {
  actionsFor,
  bulkErrorText,
  isRolloutKind,
  plural,
  runBulk,
  type ActionDef,
  type ActionId,
} from "../../lib/actions";
import { EMPTY_BOOKMARKS } from "../../lib/bookmarks";
import type { KindId, ResourceRef, Row } from "../../providers/types";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import { ScaleForm } from "./ScaleForm";
import { PortForwardForm } from "./PortForwardForm";

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
  const toggleBookmark = useStore((s) => s.toggleBookmark);
  const context = useStore((s) => s.connection.context ?? "");
  const bookmarks = useStore((s) => s.bookmarksByContext[context] ?? EMPTY_BOOKMARKS);
  const bookmarked = (row: Row) =>
    bookmarks.some(
      (b) => b.kind === kind && (b.namespace ?? "") === (row.namespace ?? "") && b.name === row.name,
    );

  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const [busy, setBusy] = useState(false);

  const actions = actionsFor(kind, rows);
  if (actions.length === 0) return null;

  const single = rows[0];
  const refOf = (row: Row): ResourceRef => ({ kind, namespace: row.namespace, name: row.name });

  /** Execute an action, then close (or report). `gone` means the objects are no more. */
  async function execute(fn: (row: Row) => Promise<unknown>, gone: boolean) {
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
      case "bookmark":
        // B56: toggle quick access for this one object (the action is per-object).
        toggleBookmark({ kind, namespace: single.namespace, name: single.name });
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
      case "uninstall":
        // B81: the release and its objects are gone, so the row leaves the table.
        void execute((row) => getProvider().uninstallRelease(refOf(row)), true);
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
      case "suspend":
        void execute((row) => getProvider().setCronjobSuspend(refOf(row), true), false);
        break;
      case "resume":
        void execute((row) => getProvider().setCronjobSuspend(refOf(row), false), false);
        break;
      case "run-now":
        void execute((row) => getProvider().runCronjob(refOf(row)), false);
        break;
      case "retry":
        // The failed Job is deleted; the retry is a fresh, unowned Job — the row
        // this menu was opened on no longer exists.
        void execute((row) => getProvider().retryJob(refOf(row)), true);
        break;
    }
  }

  // ---- confirmations ----
  if (mode.kind === "confirm") {
    return (
      <ActionConfirmDialog
        id={mode.id}
        kind={kind}
        rows={rows}
        actions={actions}
        busy={busy}
        onCancel={() => setMode({ kind: "menu" })}
        onConfirm={confirmed}
      />
    );
  }

  // ---- scale ----
  if (mode.kind === "form" && mode.id === "scale") {
    return (
      <ScaleForm
        row={single}
        busy={busy}
        onCancel={() => setMode({ kind: "menu" })}
        onApply={(replicas) =>
          void execute((row) => getProvider().scaleResource(refOf(row), replicas), false)
        }
      />
    );
  }

  // ---- port-forward ----
  if (mode.kind === "form" && mode.id === "forward") {
    return (
      <PortForwardForm
        kind={kind}
        row={single}
        busy={busy}
        onCancel={() => setMode({ kind: "menu" })}
        onForward={(port) =>
          void execute(async (row) => {
            const fwd = await getProvider().startPortForward(refOf(row), port);
            setPortForwards(useStore.getState().activeCid ?? "", await getProvider().listPortForwards());
            await copyToClipboard(`localhost:${fwd.localPort}`);
          }, false)
        }
      />
    );
  }

  // ---- the menu ----
  const safe = actions.filter((a) => !a.danger);
  const dangerous = actions.filter((a) => a.danger);

  return (
    <div className={styles.menu} role="menu" aria-label="actions for selection">
      {rows.length > 1 && (
        <div className={styles.scope}>
          {rows.length} {plural(kind, rows.length)} selected
        </div>
      )}
      {safe.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          className={styles.row}
          onClick={() => pick(a)}
        >
          {/* The bookmark action's label follows the row's state. */}
          {a.id === "bookmark" && single ? (bookmarked(single) ? "Unbookmark" : "Bookmark") : a.label}
        </button>
      ))}
      {safe.length > 0 && dangerous.length > 0 && <div className={styles.separator} />}
      {dangerous.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          className={`${styles.row} ${styles.danger}`}
          onClick={() => pick(a)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
