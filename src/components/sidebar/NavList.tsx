/**
 * Sidebar navigation (Design §1). Renders the built-in groups (Workloads, Network,
 * Config, Cluster) and their kind items with live row counts. Clicking a kind
 * switches the active resource and clears any pod selection.
 *
 * The Custom group (B15) lists CRD-backed kinds discovered on connect. It differs
 * from the built-in groups in two ways, both because there can be a lot of them
 * (freya has 44): it gets its own filter box, and its items show no row count —
 * a count would read "0" for every unopened kind, since those aren't watched yet.
 */

import { useMemo, useState } from "react";
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

export function NavList() {
  const nav = useStore((s) => s.nav);
  const rows = useStore((s) => s.rows);
  const setNav = useStore((s) => s.setNav);
  const customKinds = useStore((s) => s.customKinds);

  const [customFilter, setCustomFilter] = useState("");

  // Match on the whole id so both "argo" (group) and "application" (kind) hit.
  const visibleCustom = useMemo(() => {
    const q = customFilter.trim().toLowerCase();
    if (!q) return customKinds;
    return customKinds.filter(
      (k) => k.id.toLowerCase().includes(q) || k.kind.toLowerCase().includes(q),
    );
  }, [customKinds, customFilter]);

  return (
    <div className={styles.nav}>
      {GROUP_ORDER.map((group) =>
        group === "custom" ? (
          // Hidden entirely on clusters with no CRDs (and while disconnected).
          customKinds.length === 0 ? null : (
            <div key={group}>
              <div className={styles.sectionHeader}>
                {GROUP_LABELS[group]}
                <span className={styles.sectionCount}>{customKinds.length}</span>
              </div>
              {/* Only worth a filter box once the list is long enough to scroll. */}
              {customKinds.length > 8 && (
                <input
                  className={styles.navFilter}
                  value={customFilter}
                  onChange={(e) => setCustomFilter(e.target.value)}
                  placeholder="filter kinds…"
                />
              )}
              {visibleCustom.map((ck) => {
                const active = nav === ck.id;
                return (
                  <div
                    key={ck.id}
                    className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                    onClick={() => setNav(ck.id)}
                    // The group disambiguates same-named kinds across groups.
                    title={`${ck.kind} · ${ck.group}/${ck.version}`}
                  >
                    <span className={styles.navIcon}>◈</span>
                    <span className={styles.navLabel}>{ck.kind}</span>
                  </div>
                );
              })}
              {visibleCustom.length === 0 && (
                <div className={styles.navEmpty}>no kinds match</div>
              )}
            </div>
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

/** Built-in kinds belonging to a group, in sidebar order. */
function kindsInGroup(group: NavGroup): ResourceKind[] {
  return KIND_ORDER.filter((k) => KIND_META[k].group === group);
}
