/**
 * The Custom section (B15): lists CRD-backed kinds discovered on connect, folded
 * under their API group the way Lens does. Groups start collapsed; the one holding
 * the active kind opens automatically. Includes a filter box when list is long.
 */

import { useEffect, useMemo, useState } from "react";
import styles from "./Sidebar.module.css";
import { GROUP_LABELS } from "../../lib/kinds";
import type { CustomKind } from "../../providers/types";

interface CustomSectionProps {
  kinds: CustomKind[];
  nav: string;
  setNav: (id: string) => void;
}

export function CustomSection({ kinds, nav, setNav }: CustomSectionProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Match on the whole id so both "argo" (group) and "application" (kind) hit.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return kinds;
    return kinds.filter((k) => k.id.toLowerCase().includes(q) || k.kind.toLowerCase().includes(q));
  }, [kinds, filter]);

  // Bucket by API group, preserving the discovered order (sorted by id, so groups
  // come out alphabetically and kinds are sorted within each).
  const groups = useMemo(() => {
    const byGroup = new Map<string, CustomKind[]>();
    for (const k of visible) {
      const list = byGroup.get(k.group);
      if (list) list.push(k);
      else byGroup.set(k.group, [k]);
    }
    return [...byGroup];
  }, [visible]);

  // Open the group holding the active kind, so a selection restored from prefs
  // (or made before a reconnect) is visible rather than hidden inside a fold.
  const activeGroup = kinds.find((k) => k.id === nav)?.group;
  useEffect(() => {
    if (!activeGroup) return;
    setExpanded((prev) => (prev.has(activeGroup) ? prev : new Set(prev).add(activeGroup)));
  }, [activeGroup]);

  const toggle = (group: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(group)) next.add(group);
      return next;
    });

  // While filtering, show every match: folds would hide the thing being searched for.
  const filtering = filter.trim() !== "";

  return (
    <div>
      <div className={styles.sectionHeader}>
        {GROUP_LABELS.custom}
        <span className={styles.sectionCount}>{kinds.length}</span>
      </div>

      {/* Only worth a filter box once the list is long enough to hunt through. */}
      {kinds.length > 8 && (
        <input
          className={styles.navFilter}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter kinds…"
        />
      )}

      {groups.map(([group, groupKinds]) => {
        const open = filtering || expanded.has(group);
        return (
          <div key={group}>
            <div className={styles.navGroup} onClick={() => toggle(group)} title={group}>
              <span className={styles.navGroupChevron}>{open ? "⌄" : "›"}</span>
              <span className={styles.navGroupLabel}>{group}</span>
              <span className={styles.navCount}>{groupKinds.length}</span>
            </div>
            {open &&
              groupKinds.map((ck) => {
                const active = nav === ck.id;
                return (
                  <div
                    key={ck.id}
                    className={`${styles.navItem} ${styles.navItemNested} ${
                      active ? styles.navItemActive : ""
                    }`}
                    onClick={() => setNav(ck.id)}
                    title={`${ck.kind} · ${ck.group}/${ck.version}`}
                  >
                    <span className={styles.navLabel}>{ck.kind}</span>
                  </div>
                );
              })}
          </div>
        );
      })}

      {groups.length === 0 && <div className={styles.navEmpty}>no kinds match</div>}
    </div>
  );
}
