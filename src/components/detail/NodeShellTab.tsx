/**
 * Node debug shell tab (B53) — a root shell on the selected node's host OS.
 *
 * Unlike the pod Shell tab, this one does **not** connect when you open it. It
 * shows what the session would do and waits for an explicit click.
 *
 * That gate is the point, not politeness. Opening this session creates a
 * privileged pod on the node and escapes into the host's namespaces — root on the
 * machine, outside any container boundary. The detail tabs are cyclable with
 * `[`/`]`, so an auto-connecting tab would mean tabbing past a node silently
 * provisions a privileged pod. Explicit consent also gives somewhere honest to say
 * what's about to happen, rather than burying it in a doc nobody reads.
 *
 * Once running it behaves like any other terminal, sharing the terminal plumbing
 * with the pod shell (see useTerminal).
 */

import { useEffect, useRef, useState } from "react";
import styles from "./ShellTab.module.css";
import nodeStyles from "./NodeShellTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useTerminal } from "./useTerminal";
import type { NodeShellHandle } from "../../providers/types";

type Phase =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running"; pod: string }
  | { state: "ended"; reason: string; pod?: string };

export function NodeShellTab() {
  const row = useStore((s) => s.selectedRow);
  const node = row?.name ?? null;

  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const handleRef = useRef<NodeShellHandle | null>(null);
  // The terminal exists only once a session has been asked for; keying on the node
  // means switching nodes tears the old one down.
  const started = phase.state !== "idle";
  const { hostRef, termRef, sessionRef } = useTerminal(started && node ? node : null);

  // Switching nodes must not leave the previous node's session running — it's a
  // privileged pod, and "out of sight" is the worst way for one to be still alive.
  useEffect(() => {
    return () => {
      handleRef.current?.stop();
      handleRef.current = null;
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  useEffect(() => {
    setPhase({ state: "idle" });
  }, [node]);

  if (!node) return null;

  const start = async () => {
    setPhase({ state: "starting" });
    try {
      const handle = await getProvider().startNodeShell(
        node,
        (data) => termRef.current?.write(data),
        (reason) => {
          setPhase((p) => ({
            state: "ended",
            reason: reason || "session ended",
            pod: p.state === "running" ? p.pod : undefined,
          }));
        },
      );
      handleRef.current = handle;
      sessionRef.current = handle;
      setPhase({ state: "running", pod: handle.pod });
      // The terminal mounts in the same commit that sets "starting", so it exists
      // by now; wire keystrokes and sync the size.
      const term = termRef.current;
      if (term) {
        term.onData((d) => handle.input(d));
        handle.resize(term.cols, term.rows);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Straight to the panel, not the terminal: a start failure usually means no
      // terminal ever appeared, and the backend's message (NotReady node, image
      // pull) is the actionable part.
      setPhase({ state: "ended", reason: msg });
    }
  };

  const stop = () => {
    handleRef.current?.stop();
    handleRef.current = null;
    sessionRef.current = null;
    setPhase({ state: "ended", reason: "session closed" });
  };

  if (phase.state === "idle") {
    return (
      <div className={nodeStyles.gate}>
        <div className={nodeStyles.gateTitle}>Root shell on {node}</div>
        <div className={nodeStyles.gateBody}>
          This starts a <strong>privileged pod</strong> on {node} and enters the host&apos;s
          namespaces. You get a root shell on the machine itself — the node&apos;s filesystem,
          processes, and network, outside any container boundary.
        </div>
        <ul className={nodeStyles.gateList}>
          <li>The pod is deleted when you close the session.</li>
          <li>
            It also expires on its own after an hour, so it can&apos;t outlive k7s if something
            crashes.
          </li>
          <li>Anything you change on the node is real and is not tracked by Kubernetes.</li>
        </ul>
        <div className={nodeStyles.gateAction} onClick={() => void start()}>
          Start debug session
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          {phase.state === "starting" ? "starting debug pod…" : "node"}
        </span>
        <span className={nodeStyles.nodeName}>{node}</span>
        {/* The pod name is shown, not hidden: this feature made a privileged pod,
            and the user should be able to see and delete it themselves. */}
        {phase.state === "running" && <span className={nodeStyles.podName}>{phase.pod}</span>}
        {phase.state === "running" && (
          <span className={nodeStyles.close} onClick={stop} title="end the session and delete the pod">
            ✕ end session
          </span>
        )}
      </div>

      <div className={styles.shell} ref={hostRef} />

      {phase.state === "ended" && (
        <div className={styles.endedBar}>
          <span className={styles.endedReason}>{phase.reason}</span>
          <span
            className={styles.reconnect}
            onClick={() => setPhase({ state: "idle" })}
            title="back to the start screen"
          >
            ↻ start again
          </span>
        </div>
      )}
    </div>
  );
}
