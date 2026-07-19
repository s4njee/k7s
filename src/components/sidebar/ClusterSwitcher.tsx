/**
 * Cluster switcher (Design §1, top of the sidebar). Shows the active cluster with
 * an initials badge and a live connection status line, and opens a dropdown of
 * kubeconfig contexts. Selecting one triggers the connect flow.
 */

import { useRef } from "react";
import styles from "./Sidebar.module.css";
import { useStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import { connectTo } from "../../lib/connect";
import { getProvider } from "../../providers";

/** First two letters of the cluster name, uppercased ("FR" for "freya"). */
function initials(name: string): string {
  return name.slice(0, 2).toUpperCase() || "K7";
}

export function ClusterSwitcher() {
  const connection = useStore((s) => s.connection);
  const clusterStatus = useStore((s) => s.clusterStatus);
  const contexts = useStore((s) => s.contexts);
  const open = useStore((s) => s.openMenu === "cluster");
  const toggleMenu = useStore((s) => s.toggleMenu);
  const closeMenus = useStore((s) => s.closeMenus);
  const setContexts = useStore((s) => s.setContexts);
  const addImportedFile = useStore((s) => s.addImportedFile);

  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, closeMenus, open);

  // Import contexts from a kubeconfig file (native picker), then merge them into
  // the switcher list. A null result means the user cancelled the dialog.
  const onImport = async () => {
    closeMenus();
    const result = await getProvider().importKubeconfig();
    if (!result) return;
    setContexts(result.contexts);
    // Remember the file so its contexts come back on the next launch (B17).
    addImportedFile(result.path);
  };

  // Display name: the connected cluster, else the selected context, else a stub.
  const name = connection.clusterName ?? connection.context ?? "no cluster";

  // Status line: dot color + text reflect the connection lifecycle.
  const { dotColor, statusText } = statusDisplay(
    connection.phase,
    clusterStatus?.version,
  );

  return (
    <div className={styles.switcher} ref={ref}>
      <div className={styles.switcherButton} onClick={() => toggleMenu("cluster")}>
        <div className={styles.badge}>{initials(name)}</div>
        <div className={styles.switcherText}>
          <div className={styles.clusterName}>{name}</div>
          <div className={styles.statusLine}>
            <span className={styles.dot} style={{ background: dotColor }} />
            {statusText}
          </div>
        </div>
        <span className={styles.chevron}>▼</span>
      </div>

      {open && (
        <div className={styles.menu}>
          {contexts.map((ctx) => {
            const isCurrent = ctx.name === connection.context;
            return (
              <div
                key={ctx.name}
                className={`${styles.menuRow} ${isCurrent ? styles.menuRowActive : ""}`}
                onClick={() => {
                  closeMenus();
                  // No-op if re-selecting the already-connected context.
                  if (!isCurrent) void connectTo(ctx.name);
                }}
              >
                <span
                  className={styles.dot}
                  style={{ background: isCurrent ? "var(--status-ok)" : "var(--dot-inactive)" }}
                />
                <span className={styles.menuName}>{ctx.name}</span>
                <span className={styles.menuEnv}>{ctx.cluster}</span>
              </div>
            );
          })}
          {contexts.length === 0 && (
            <div className={styles.menuRow}>
              <span className={styles.menuName} style={{ color: "var(--text-faint)" }}>
                no contexts
              </span>
            </div>
          )}

          {/* Import action, separated from the context list. */}
          <div className={styles.menuDivider} />
          <div className={styles.menuRow} onClick={() => void onImport()}>
            <span className={styles.importIcon}>＋</span>
            <span className={styles.menuName}>Import kubeconfig…</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Map connection phase → status dot color + text (with version when connected). */
function statusDisplay(
  phase: "idle" | "connecting" | "connected" | "error",
  version?: string,
): { dotColor: string; statusText: string } {
  switch (phase) {
    case "connected":
      return {
        dotColor: "var(--status-ok)",
        statusText: `connected · ${version ?? ""}`.trim(),
      };
    case "connecting":
      return { dotColor: "var(--status-warn)", statusText: "connecting…" };
    default:
      return { dotColor: "var(--status-err)", statusText: "disconnected" };
  }
}
