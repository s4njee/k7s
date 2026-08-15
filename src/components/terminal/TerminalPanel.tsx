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
      {/* A terminal tab carries its own close button, which a strict
          role="tablist"/"tab" pattern forbids (axe aria-required-children +
          nested-interactive). So this strip is a button group: each tab is a
          real button marked current, with a sibling close. */}
      <div
        className={styles.tabs}
        role="group"
        aria-label="kubectl terminals"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const idx = terminals.findIndex((t) => t.id === activeTerminalId);
          const dir = e.key === "ArrowRight" ? 1 : terminals.length - 1;
          setActiveTerminal(terminals[(idx + dir) % terminals.length].id);
        }}
      >
        {terminals.map((t) => {
          const label = connections[t.cid]?.clusterName ?? t.cid;
          const active = t.id === activeTerminalId;
          return (
            <div
              key={t.id}
              className={`${styles.tabRow} ${active ? styles.tabRowActive : ""}`}
            >
              {/* The label is the tab button; the close is a sibling button. */}
              <button
                type="button"
                className={styles.tab}
                onClick={() => setActiveTerminal(t.id)}
                aria-current={active ? "true" : undefined}
                title={`kubectl terminal · ${label}`}
              >
                <span
                  className={styles.dot}
                  style={{ background: railColor(t.cid, clusterColors) }}
                  aria-hidden="true"
                />
                <span className={styles.tabLabel}>{label}</span>
              </button>
              <button
                type="button"
                className={styles.close}
                aria-label={`close terminal ${label}`}
                onClick={() => closeTerminal(t.id)}
              >
                ✕
              </button>
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
