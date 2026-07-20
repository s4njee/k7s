/**
 * Actions menu (B3, B34) for the detail header: a "⋯" button opening a dropdown
 * of kind-appropriate mutations.
 *
 * Since B39 this file is only the trigger and its placement — the items,
 * confirmations, and forms live in {@link ActionList}, shared with the table's
 * row context menu. That sharing is the point: two copies of "what can be done
 * to this kind" would eventually disagree, and the first divergence would be a
 * menu offering Delete on something the other refuses.
 *
 * The panel always acts on exactly one row: the one it is showing. Bulk is a
 * table concept, and a panel acting on rows it isn't displaying would be lying
 * about its own header.
 */

import { useRef, useState } from "react";
import styles from "./DetailPanel.module.css";
import { useClickOutside } from "../../hooks/useClickOutside";
import { ActionList } from "../actions/ActionList";
import { actionsFor } from "../../lib/actions";
import type { KindId, Row } from "../../providers/types";

interface ActionsMenuProps {
  kind: KindId;
  row: Row;
  /** Report an API error (or null to clear) for the header banner. */
  onError: (msg: string | null) => void;
  /** Called once the object is gone, so the panel can close. */
  onDeleted: () => void;
}

export function ActionsMenu({ kind, row, onError, onDeleted }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  // Nothing actionable for this kind — render no button rather than one that
  // opens an empty menu. Asked of the same function the menu renders from, so
  // the button's existence and the menu's contents can't disagree.
  if (actionsFor(kind, [row]).length === 0) return null;

  return (
    <div className={styles.actionsWrap} ref={ref}>
      <div className={styles.actionsButton} onClick={() => setOpen((o) => !o)} title="actions">
        ⋯
      </div>
      {open && (
        <div className={styles.actionsAnchor}>
          <ActionList
            kind={kind}
            rows={[row]}
            onError={onError}
            onClose={() => setOpen(false)}
            onGone={onDeleted}
          />
        </div>
      )}
    </div>
  );
}
