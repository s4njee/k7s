/**
 * Sidebar navigation (Design §1). Renders the built-in groups (Workloads, Network,
 * Config, Cluster) and their kind items with live row counts. Clicking a kind
 * switches the active resource and clears any pod selection.
 *
 * The Custom section (B15) lists CRD-backed kinds discovered on connect, folded
 * under their API group the way Lens does — freya has 44 CRDs across 10 groups, so
 * a flat list would bury the built-in nav. Groups start collapsed; the one holding
 * the active kind opens automatically.
 *
 * Custom items show no row count: it would read "0" for every unopened kind, since
 * those aren't watched until you open them.
 */

import { useEffect, useMemo, useState } from "react";
import styles from "./Sidebar.module.css";
import { useStore } from "../../store";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  KIND_META,
  KIND_ORDER,
  type NavGroup,
  type ResourceKind,
} from "../../lib/kinds";
import type { CustomKind } from "../../providers/types";

export function NavList() {
  const nav = useStore((s) => s.nav);
  const rows = useStore((s) => s.rows);
  const setNav = useStore((s) => s.setNav);
  const customKinds = useStore((s) => s.customKinds);

  return (
    <div className={styles.nav}>
      {GROUP_ORDER.map((group) =>
        group === "custom" ? (
          // Hidden entirely on clusters with no CRDs (and while disconnected).
          customKinds.length === 0 ? null : (
            <CustomSection key={group} kinds={customKinds} nav={nav} setNav={setNav} />
          )
        ) : (
          <div key={group}>
            <div className={styles.sectionHeader}>{GROUP_LABELS[group]}</div>
            {kindsInGroup(group).map((kind) => {
              const active = nav === kind;
              return (
                <div
                  key={kind}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                  onClick={() => setNav(kind)}
                >
                  <span className={styles.navIcon}>{KIND_META[kind].icon}</span>
                  <span className={styles.navLabel}>{KIND_META[kind].label}</span>
                  {/* Live count = number of rows currently in the store for this kind. */}
                  <span className={styles.navCount}>{rows[kind].length}</span>
                </div>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

/** The Custom section: a filter box plus one collapsible row per API group. */
function CustomSection({
  kinds,
  nav,
  setNav,
}: {
  kinds: CustomKind[];
  nav: string;
  setNav: (id: string) => void;
}) {
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

/** Built-in kinds belonging to a group, in sidebar order. */
function kindsInGroup(group: NavGroup): ResourceKind[] {
  return KIND_ORDER.filter((k) => KIND_META[k].group === group);
}
