/**
 * One local kubectl terminal's xterm + session (B82). The backend spawns the
 * user's shell on a pty with KUBECONFIG pointed at the viewed cluster; this
 * component pipes keystrokes and size to that session and writes its output to
 * the xterm. When the session ends (you type `exit`, or the backend dies), the
 * terminal's tab closes itself.
 *
 * The session handle is component-local, like the pod/node shells — the store
 * only tracks that the terminal exists, so the tab strip can render it.
 */

import { useEffect } from "react";
import styles from "./TerminalPanel.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useTerminal } from "../detail/useTerminal";
import type { ShellHandle } from "../../providers/types";
import type { TerminalInfo } from "../../store/types";
import { errDisplay } from "../../lib/errors";

export function KubectlTerminal({ terminal, active }: { terminal: TerminalInfo; active: boolean }) {
  const closeTerminal = useStore((s) => s.closeTerminal);

  // The terminal is keyed by the tab's own id — it lives for the tab's lifetime.
  const { hostRef, termRef, sessionRef } = useTerminal(terminal.id);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    let handle: ShellHandle | null = null;
    let cancelled = false;
    let dataSub: { dispose(): void } | null = null;

    void getProvider()
      .startKubectlTerminal(
        terminal.cid,
        (data) => term.write(data),
        (_reason) => {
          if (cancelled) return;
          // `exit` (or a dead backend) removes its own tab.
          closeTerminal(terminal.id);
        },
      )
      .then((h) => {
        if (cancelled) {
          h.stop();
          return;
        }
        handle = h;
        sessionRef.current = h;
        dataSub = term.onData((d) => h.input(d));
        h.resize(term.cols, term.rows);
      })
      .catch((e) => {
        const msg = errDisplay(e);
        term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
        if (!cancelled) closeTerminal(terminal.id);
      });

    return () => {
      cancelled = true;
      dataSub?.dispose();
      handle?.stop();
      sessionRef.current = null;
    };
  }, [terminal.id, terminal.cid]);

  // Focus behaviour: a freshly-opened terminal grabs the keyboard (⌘T → type
  // immediately), and clicking a tab hands focus to that xterm. Hidden terminals
  // are display:none; this effect runs after the re-activation re-render, so the
  // host is visible again before focus is requested.
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active, terminal.id]);

  return (
    <div ref={hostRef} className={active ? styles.terminal : styles.terminalHidden} />
  );
}
