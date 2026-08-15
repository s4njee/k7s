/**
 * A reference to another object, rendered as a click-through link (B33, B40).
 * Inherits the surrounding colour so a linked status keeps its tone; the
 * underline is what marks it navigable.
 */

import styles from "../PropertiesTab.module.css";
import { useStore } from "../../../store";
import type { NavTarget } from "../../../providers/types";

export function NavLink({ target, children }: { target: NavTarget; children: React.ReactNode }) {
  const navigateTo = useStore((s) => s.navigateTo);
  return (
    <button
      type="button"
      className={styles.navLink}
      title={`Go to ${target.kind} ${target.name}`}
      onClick={() => navigateTo(target)}
    >
      {children}
    </button>
  );
}
