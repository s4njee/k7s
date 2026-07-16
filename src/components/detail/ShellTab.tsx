/**
 * Shell tab (B4): an interactive terminal (xterm) attached to the selected pod's
 * container via the backend exec session. Keystrokes go to the container; output
 * is written to the terminal; terminal resizes are forwarded. The session is torn
 * down on unmount / pod / container change.
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import styles from "./ShellTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import type { ShellHandle } from "../../providers/types";

// xterm needs concrete colors (it can't read CSS variables); these mirror the
// design tokens for the terminal surface.
const TERM_THEME = {
  background: "#0a0a0c",
  foreground: "#d2d2d8",
  cursor: "#4d9fff",
  selectionBackground: "#23324a",
  black: "#0a0a0c",
  brightBlack: "#57575f",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#4d9fff",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#d2d2d8",
};

export function ShellTab() {
  const pod = useStore((s) => s.selectedRow);
  const containerIndex = useStore((s) => s.containerIndex);
  const hostRef = useRef<HTMLDivElement>(null);

  const containers = pod?.pod?.containers ?? [];
  // Shell into a real container (ignore the logs "all" option) — default the first.
  const container = containers.length ? containers[containerIndex % containers.length] : "";

  useEffect(() => {
    if (!hostRef.current || !pod) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    let handle: ShellHandle | null = null;
    let cancelled = false;

    void getProvider()
      .startShell(
        { kind: "pods", namespace: pod.namespace, name: pod.name },
        container,
        (data) => term.write(data),
        (reason) => term.write(`\r\n\x1b[90m[${reason}]\x1b[0m\r\n`),
      )
      .then((h) => {
        if (cancelled) {
          h.stop();
          return;
        }
        handle = h;
        // Pipe keystrokes to the container and sync the initial size.
        term.onData((d) => h.input(d));
        h.resize(term.cols, term.rows);
      })
      .catch((e) => term.write(`\r\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`));

    // Refit + report size when the panel resizes.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        handle?.resize(term.cols, term.rows);
      } catch {
        /* element detached mid-resize */
      }
    });
    ro.observe(hostRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      handle?.stop();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pod?.uid, container]);

  return <div className={styles.shell} ref={hostRef} />;
}
