/**
 * Update state (B72): what the UI renders for automatic updates.
 *
 * The store deliberately holds only plain, serializable state — the live Update
 * handle from tauri-plugin-updater lives module-scoped in lib/updates.ts, which
 * also owns the actual checking/installing (and the silent-failure rule: demo
 * mode, an airgapped machine, and a dev build all degrade to "no update").
 */

import type { StateCreator } from "zustand";
import type { AppState, UpdateActions, UpdateState } from "./types";

export const initialUpdateState: UpdateState = {
  status: "idle",
  currentVersion: undefined,
  version: undefined,
  notes: undefined,
};

export const createUpdateSlice: StateCreator<
  AppState,
  [],
  [],
  UpdateState & UpdateActions
> = (set) => ({
  ...initialUpdateState,
  setUpdate: (patch) => set((s) => ({ ...s, ...patch })),
});
