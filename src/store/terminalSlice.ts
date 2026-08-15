/**
 * Terminal slice (B82): the open local kubectl terminals and which one is
 * visible. Only the *registry* lives here (id + cluster); each terminal's
 * session handle is component-local in the TerminalPanel, like the shells. A
 * terminal opened on one cluster keeps running while another is viewed, so this
 * is a flat list, not per-cid state.
 */

import type { StateCreator } from "zustand";
import type { AppState, Cid, TerminalActions, TerminalInfo, TerminalSliceState } from "./types";

/** Monotonic id generator (frontend tab identity, not the backend stream id). */
let terminalSeq = 0;

export const createTerminalSlice: StateCreator<
  AppState,
  [],
  [],
  TerminalSliceState & TerminalActions
> = (set, get) => ({
  terminals: [],
  activeTerminalId: null,

  openTerminal: (cid: Cid) => {
    // A terminal has nothing to target without a connected cluster.
    if (!cid || get().connections[cid]?.phase !== "connected") return;
    const id = `term-${++terminalSeq}`;
    set((s) => ({
      terminals: [...s.terminals, { id, cid }],
      // The new terminal opens focused.
      activeTerminalId: id,
    }));
  },

  closeTerminal: (id: string) =>
    set((s) => {
      const terminals: TerminalInfo[] = s.terminals.filter((t) => t.id !== id);
      return {
        terminals,
        // Focus the last remaining terminal, or none.
        activeTerminalId:
          s.activeTerminalId === id
            ? (terminals[terminals.length - 1]?.id ?? null)
            : s.activeTerminalId,
      };
    }),

  setActiveTerminal: (id: string) => set({ activeTerminalId: id }),
});
