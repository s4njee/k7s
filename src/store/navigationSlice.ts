/**
 * Navigation state and action handlers.
 */

import type { StateCreator } from "zustand";
import type { AppState, NavigationActions, NavigationState } from "./types";
import type { KindId, Row } from "../providers/types";
import { hasLogs } from "../lib/kinds";
import { EMPTY_SELECTION, type SelectionState } from "../lib/selection";
import type { DetailTab } from "./types";
import type { SinceOption } from "../lib/logview";
import type { LogLine } from "../providers/types";

export const initialNavigationState: NavigationState = {
  nav: "pods",
  navByCid: {},
  namespace: "all",
  namespaceByCid: {},
  tableFilter: "",
  sortCol: null,
  sortDir: "asc",
  openMenu: null,
};

export function selectionPatch(row: Row, kind: KindId) {
  return {
    selectedRow: row,
    selection: { selected: [row.uid], anchor: row.uid } as SelectionState,
    activeTab: (hasLogs(kind, !!row.pod) ? "logs" : "yaml") as DetailTab,
    yamlEditing: false,
    logBuffer: [] as LogLine[],
    logSearch: "",
    containerIndex: 0,
    following: true,
    logPrevious: false,
    logSince: "all" as SinceOption,
  };
}

export function jumpPatch(current: { namespace: string }, kind: KindId, row?: Row) {
  const base = {
    nav: kind,
    openMenu: null,
    tableFilter: "",
    sortCol: null,
    sortDir: "asc" as const,
    paletteOpen: false,
  };
  if (!row) return { ...base, selectedRow: null, selection: EMPTY_SELECTION };

  const namespace =
    row.namespace && current.namespace !== "all" && current.namespace !== row.namespace
      ? row.namespace
      : current.namespace;

  return { ...base, namespace, ...selectionPatch(row, kind) };
}

export const createNavigationSlice: StateCreator<
  AppState,
  [],
  [],
  NavigationState & NavigationActions
> = (set) => ({
  ...initialNavigationState,

  setNav: (kind) =>
    set({
      nav: kind,
      selectedRow: null,
      selection: EMPTY_SELECTION,
      openMenu: null,
      tableFilter: "",
      sortCol: null,
      sortDir: "asc",
    }),

  setNamespace: (ns) =>
    set({ namespace: ns, openMenu: null, selectedRow: null, selection: EMPTY_SELECTION }),

  setTableFilter: (q) => set({ tableFilter: q }),

  toggleSort: (col) =>
    set((s) =>
      s.sortCol === col
        ? { sortDir: s.sortDir === "asc" ? "desc" : "asc" }
        : { sortCol: col, sortDir: "asc" },
    ),

  toggleMenu: (menu) => set((s) => ({ openMenu: s.openMenu === menu ? null : menu })),

  closeMenus: () => set({ openMenu: null }),

  jumpTo: (kind, row) => set((s) => jumpPatch(s, kind, row)),

  navigateTo: (target) =>
    set((s) => {
      const targetRows = s.rows[target.kind] ?? [];
      const found = targetRows.find(
        (r) => r.name === target.name && (!target.namespace || r.namespace === target.namespace),
      );
      const row =
        found ?? {
          uid: `${target.namespace ?? ""}/${target.name}`,
          name: target.name,
          namespace: target.namespace,
          cells: [],
        };
      return jumpPatch(s, target.kind, row);
    }),

  viewPods: (namespace, selector) =>
    set((s) => ({
      nav: "pods",
      openMenu: null,
      sortCol: null,
      sortDir: "asc",
      paletteOpen: false,
      selectedRow: null,
      selection: EMPTY_SELECTION,
      namespace: namespace || s.namespace,
      tableFilter: selector,
    })),
});
