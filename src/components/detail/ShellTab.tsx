/**
 * Shell tab (B4, B19): an interactive terminal (xterm) attached to the selected
 * pod's container via the backend exec session. Keystrokes go to the container;
 * output is written to the terminal; terminal resizes are forwarded.
 *
 * The terminal and the session have deliberately different lifetimes (B19):
 *   - the terminal belongs to a pod+container, and
 *   - a session is one connection to it, which can end (you type `exit`, the pod
 *     restarts) and be reconnected.
 * Keeping them apart is what preserves scrollback across a reconnect — the
 * terminal isn't rebuilt, only the session underneath it is.
 *
 * The container choice is the tab's own (B19): it used to piggyback on the Logs
 * tab's cycler index, so cycling log containers silently moved your shell.
 */

import { useEffect, useState } from "react";
import styles from "./ShellTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useTerminal } from "./useTerminal";
import type { ShellHandle } from "../../providers/types";

export function ShellTab() {
  const pod = useStore((s) => s.selectedRow);

  const containers = pod?.pod?.containers ?? [];

  // The tab's own container choice, defaulting to the first.
  const [container, setContainer] = useState("");
  useEffect(() => {
    setContainer(containers[0] ?? "");
    // Only on pod change: `containers` is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pod?.uid]);

  // Why the session ended, or null while it's live. Drives the reconnect bar.
  const [ended, setEnded] = useState<string | null>(null);
  // Bumping this re-runs the session effect against the same terminal.
  const [attempt, setAttempt] = useState(0);

  // The terminal is rebuilt only when the target changes; a reconnect reuses it.
  const { hostRef, termRef, sessionRef } = useTerminal(
    pod && container ? `${pod.uid}:${container}` : null,
  );

  // ---- the session: re-runs on reconnect, writing into the existing terminal ----
  useEffect(() => {
    const term = termRef.current;
    if (!term || !pod || !container) return;

    setEnded(null);
    let handle: ShellHandle | null = null;
    let cancelled = false;
    // xterm's onData returns a disposable; without disposing it, every reconnect
    // would stack another listener and each keystroke would be sent twice.
    let dataSub: { dispose(): void } | null = null;

    void getProvider()
      .startShell(
        { kind: "pods", namespace: pod.namespace, name: pod.name },
        container,
        (data) => term.write(data),
        (reason) => {
          if (!cancelled) setEnded(reason || "session ended");
        },
      )
      .then((h) => {
        if (cancelled) {
          h.stop();
          return;
        }
        handle = h;
        sessionRef.current = h;
        // Pipe keystrokes to the container and sync the initial size.
        dataSub = term.onData((d) => h.input(d));
        h.resize(term.cols, term.rows);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
        if (!cancelled) setEnded(msg);
      });

    return () => {
      cancelled = true;
      dataSub?.dispose();
      handle?.stop();
      sessionRef.current = null;
    };
  }, [pod?.uid, container, attempt]);

  /** Start a fresh session in the same terminal, marking the break in scrollback. */
  const reconnect = () => {
    termRef.current?.write("\r\n\x1b[90m── reconnecting ──\x1b[0m\r\n");
    setAttempt((n) => n + 1);
  };

  return (
    <div className={styles.wrap}>
      {/* Only worth a picker when there's a choice to make. */}
      {containers.length > 1 && (
        <div className={styles.header}>
          <span className={styles.headerLabel}>container</span>
          <select
            className={styles.picker}
            value={container}
            onChange={(e) => setContainer(e.target.value)}
          >
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={styles.shell} ref={hostRef} />

      {ended !== null && (
        <div className={styles.endedBar}>
          <span className={styles.endedReason}>{ended}</span>
          <span className={styles.reconnect} onClick={reconnect} title="start a new session">
            ↻ reconnect
          </span>
        </div>
      )}
    </div>
  );
}
