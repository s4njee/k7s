/**
 * Sidebar navigation (Design §1). Renders the built-in groups (Workloads, Network,
 * Config, Storage, Cluster, Helm, Access) and their kind items with live row counts.
 * Clicking a kind switches the active resource and clears any pod selection.
 * Discovered CRD kinds are rendered in CustomSection.
 */

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
import { CustomSection } from "./CustomSection";
import { ProblemsBadge } from "./ProblemsBadge";

export function NavList() {
  const nav = useStore((s) => s.nav);
  const rows = useStore((s) => s.rows);
  const setNav = useStore((s) => s.setNav);
  const customKinds = useStore((s) => s.customKinds);
  // B74-L: a kind whose watcher is Forbidden or Backoff gets a warning dot, so
  // "secrets can't be read" is visible at a glance — never a quiet empty count.
  const watcherHealth = useStore((s) => s.watcherHealth);

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
            {/* B90: a kind whose API the cluster doesn't serve is hidden, not
                shown as a broken table. */}
            {kindsInGroup(group)
              .filter((kind) => watcherHealth[kind]?.state !== "unsupported")
              .map((kind) => {
              const active = nav === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                  onClick={() => setNav(kind)}
                  aria-current={active ? "page" : undefined}
                >
                  <span className={styles.navIcon}>{KIND_META[kind].icon}</span>
                  <span className={styles.navLabel}>{KIND_META[kind].label}</span>
                  {/* Live count = number of rows currently in the store for this kind. */}
                  {kind === "problems" ? (
                    <ProblemsBadge rows={rows.problems} />
                  ) : (
                    <span className={styles.navCount}>{rows[kind].length}</span>
                  )}
                  {!["problems", "overview", "events"].includes(kind) &&
                    (watcherHealth[kind]?.state === "forbidden" ||
                      watcherHealth[kind]?.state === "backoff") && (
                      <span
                        className={`${styles.navHealthDot} ${
                          watcherHealth[kind].state === "forbidden"
                            ? styles.navHealthDotErr
                            : styles.navHealthDotWarn
                        }`}
                        title={
                          watcherHealth[kind].state === "forbidden"
                            ? `${kind}: permission denied — can't read this kind`
                            : `${kind}: watcher reconnecting — last update ${
                                watcherHealth[kind].lastSuccessMs != null ? "a while ago" : "never"
                              }`
                        }
                      />
                    )}
                </button>
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
