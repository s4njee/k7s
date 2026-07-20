/**
 * The xterm terminal behind the Shell tabs — shared by the pod shell (B4/B19) and
 * the node debug shell (B53).
 *
 * Shared because the two tabs differ only in *what they attach to*; the terminal
 * itself — fitting, resize reporting, palette changes, disposal — behaves
 * identically, and two copies would drift the moment one of them was fixed.
 *
 * The terminal and the session deliberately have different lifetimes: the terminal
 * belongs to a target, a session is one connection to it. A session can end (you
 * type `exit`, the pod restarts) and be reconnected into the *same* terminal, which
 * is what preserves scrollback across a reconnect.
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useResolvedTheme } from "../../hooks/useTheme";
import { termTheme } from "../../lib/theme";

/** Anything that can receive keystrokes and a terminal size. */
export interface Resizable {
  resize(cols: number, rows: number): void;
}

export interface TerminalHandles {
  /** Attach to the host element. */
  hostRef: React.RefObject<HTMLDivElement | null>;
  /** The live terminal, or null before mount / after disposal. */
  termRef: React.RefObject<Terminal | null>;
  /** Set this so panel resizes are forwarded to the running session. */
  sessionRef: React.RefObject<Resizable | null>;
}

/**
 * Create and own a terminal, rebuilt whenever `key` changes.
 *
 * `key` is the identity of what the terminal is attached to (pod uid + container,
 * or node name). Changing it means a genuinely different target, so the scrollback
 * *should* go — unlike a reconnect, which must not rebuild.
 */
export function useTerminal(key: string | null): TerminalHandles {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<Resizable | null>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    if (!hostRef.current || !key) return;

    // Resolve colours from the host so light-mode dark panels (scoped tokens on
    // [data-surface="panel"]) win over the document palette.
    const host = hostRef.current;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: termTheme(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

    // Refit + report size when the panel resizes. Reads the session through a ref
    // so a reconnect doesn't need to rebuild the observer.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sessionRef.current?.resize(term.cols, term.rows);
      } catch {
        /* element detached mid-resize */
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [key]);

  // Palette changes re-theme in place (B52) rather than rebuilding, for the same
  // reason a reconnect doesn't: the scrollback is the session, and switching to
  // light mode is no reason to throw away what you were reading.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme(hostRef.current);
  }, [theme, key]);

  return { hostRef, termRef, sessionRef };
}
