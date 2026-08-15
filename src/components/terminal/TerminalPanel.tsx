/**
 * The kubectl terminal panel (B82): a cluster-badged tab strip above the
 * statusbar plus the active terminal's xterm. Every open terminal stays mounted
 * (its session keeps running) with the inactive ones hidden, so a tab switch
 * preserves each xterm's scrollback and its shell.
 *
 * Opens from the statusbar "Terminal" pill or ⌘T, which call
 * `openTerminal(activeCid)` — the store tracks the open set; each tab's session
 * handle lives in its own {@link KubectlTerminal}.
 */

import styles from "./TerminalPanel.module.css";
import { useStore } from "../../store";
import { railColor } from "../sidebar/ClusterSwitcher";
import { KubectlTerminal } from "./KubectlTerminal";

export function TerminalPanel() {
  const terminals = useStore((s) => s.terminals);
  const activeTerminalId = useStore((s) => s.activeTerminalId);
  const connections = useStore((s) => s.connections);
  const clusterColors = useStore((s) => s.clusterColors);
  const setActiveTerminal = useStore((s) => s.setActiveTerminal);
  const closeTerminal = useStore((s) => s.closeTerminal);

  if (terminals.length === 0) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {terminals.map((t) => {
          const label = connections[t.cid]?.clusterName ?? t.cid;
          const active = t.id === activeTerminalId;
          return (
            <div
              key={t.id}
              className={`${styles.tab} ${active ? styles.tabActive : ""}`}
              onClick={() => setActiveTerminal(t.id)}
              title={`kubectl terminal · ${label}`}
            >
              <span className={styles.dot} style={{ background: railColor(t.cid, clusterColors) }} />
              <span className={styles.tabLabel}>{label}</span>
              <span
                className={styles.close}
                role="button"
                aria-label={`close terminal ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t.id);
                }}
              >
                ✕
              </span>
            </div>
          );
        })}
      </div>
      <div className={styles.body}>
        {terminals.map((t) => (
          <KubectlTerminal key={t.id} terminal={t} active={t.id === activeTerminalId} />
        ))}
      </div>
    </div>
  );
}
