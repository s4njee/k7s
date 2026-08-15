/**
 * Central application store (Zustand). Holds state across navigation, connection,
 * live cluster data, and the detail panel. UI components subscribe to slices of this;
 * provider event handlers call the setters.
 */

import { create } from "zustand";
import { DEFAULT_SETTINGS } from "./lib/settings";
import type { KindId, Row } from "./providers/types";
import type { AppState, ConnectionState, DetailTab, OpenMenu, RowMap } from "./store/types";
import { createNavigationSlice } from "./store/navigationSlice";
import { createConnectionSlice } from "./store/connectionSlice";
import { createDataSlice, NODE_SAMPLE_CAP, POD_SAMPLE_CAP } from "./store/dataSlice";
import { createDetailSlice } from "./store/detailSlice";
import { createUpdateSlice } from "./store/updateSlice";

// Re-export all types and constants for backwards compatibility
export type { AppState, ConnectionState, DetailTab, OpenMenu, RowMap };
export { NODE_SAMPLE_CAP, POD_SAMPLE_CAP };

/**
 * Ring-buffer cap for the log view (the design default, and the starting value
 * of the user-editable setting — see lib/settings.ts).
 */
export const LOG_BUFFER_CAP = DEFAULT_SETTINGS.logBufferCap;

/** Shared empty array so `rowsFor` returns a stable reference (avoids re-renders). */
const EMPTY_ROWS: Row[] = [];

/** Rows for a kind, or an empty array for a custom kind not yet watched (B15). */
export function rowsFor(rows: RowMap, kind: KindId): Row[] {
  return rows[kind] ?? EMPTY_ROWS;
}

export const useStore = create<AppState>()((...a) => ({
  ...createNavigationSlice(...a),
  ...createConnectionSlice(...a),
  ...createDataSlice(...a),
  ...createDetailSlice(...a),
  ...createUpdateSlice(...a),
}));
