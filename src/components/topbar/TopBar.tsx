/**
 * Top bar (Design §2): breadcrumb (cluster / group / Kind) on the left and the
 * namespace filter dropdown on the right. The namespace list is live — derived
 * from the Namespaces the backend is watching, plus the "all" option.
 */

import { useMemo, useRef } from "react";
import styles from "./TopBar.module.css";
import { useStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import { kindMeta } from "../../lib/kinds";

export function TopBar() {
  const nav = useStore((s) => s.nav);
  const namespace = useStore((s) => s.namespace);
  const connection = useStore((s) => s.connection);
  const nsRows = useStore((s) => s.rows.namespaces);
  const open = useStore((s) => s.openMenu === "ns");
  const toggleMenu = useStore((s) => s.toggleMenu);
  const closeMenus = useStore((s) => s.closeMenus);
  const setNamespace = useStore((s) => s.setNamespace);
  const customKinds = useStore((s) => s.customKinds);

  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, closeMenus, open);

  const cluster = connection.clusterName ?? connection.context ?? "k7s";
  // Runtime lookup: custom (CRD-backed) kinds aren't in the static table (B15).
  const meta = kindMeta(nav, customKinds);

  // "all" plus the live namespace names (sorted for stable display).
  const namespaces = useMemo(() => {
    const names = nsRows.map((r) => r.name).sort();
    return ["all", ...names];
  }, [nsRows]);

  return (
    <div className={styles.topbar}>
      <div className={styles.breadcrumb}>
        {cluster} <span className={styles.sep}>/</span> {meta?.group ?? "custom"}{" "}
        <span className={styles.sep}>/</span>{" "}
        <span className={styles.kind}>{meta?.label ?? nav}</span>
      </div>

      <div className={styles.spacer} />

      <div className={styles.nsWrap} ref={ref}>
        <div className={styles.nsButton} onClick={() => toggleMenu("ns")}>
          <span className={styles.nsPrefix}>ns:</span>
          <span className={styles.nsValue}>{namespace}</span>
          <span className={styles.nsChevron}>▼</span>
        </div>

        {open && (
          <div className={styles.nsMenu}>
            {namespaces.map((ns) => {
              const selected = ns === namespace;
              return (
                <div
                  key={ns}
                  className={`${styles.nsRow} ${selected ? styles.nsRowSelected : ""}`}
                  onClick={() => setNamespace(ns)}
                >
                  <span className={styles.nsCheck}>{selected ? "✓" : ""}</span>
                  {ns}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
