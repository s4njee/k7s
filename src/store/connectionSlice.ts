/**
 * Connection and cluster context state and actions.
 */

import type { StateCreator } from "zustand";
import type { AppState, ConnectionActions, ConnectionSliceState } from "./types";
import { sameBookmark } from "../lib/bookmarks";

export const initialConnectionState: ConnectionSliceState = {
  connection: { phase: "idle", context: null, clusterName: null },
  clusterStatus: null,
  watchCount: 0,
  contexts: [],
  importedFiles: [],
  bookmarksByContext: {},
};

export const createConnectionSlice: StateCreator<
  AppState,
  [],
  [],
  ConnectionSliceState & ConnectionActions
> = (set) => ({
  ...initialConnectionState,

  setConnection: (c) => set((s) => ({ connection: { ...s.connection, ...c } })),
  setContexts: (contexts) => set({ contexts }),
  setImportedFiles: (paths) => set({ importedFiles: paths }),

  addImportedFile: (path) =>
    set((s) =>
      s.importedFiles.includes(path) ? s : { importedFiles: [...s.importedFiles, path] },
    ),

  addBookmark: (bookmark) =>
    set((s) => {
      const ctx = s.connection.context ?? "";
      const list = s.bookmarksByContext[ctx] ?? [];
      if (list.some((b) => sameBookmark(b, bookmark))) return s;
      return {
        bookmarksByContext: { ...s.bookmarksByContext, [ctx]: [...list, bookmark] },
      };
    }),

  removeBookmark: (bookmark) =>
    set((s) => {
      const ctx = s.connection.context ?? "";
      const list = s.bookmarksByContext[ctx] ?? [];
      const next = list.filter((b) => !sameBookmark(b, bookmark));
      if (next.length === list.length) return s;
      return { bookmarksByContext: { ...s.bookmarksByContext, [ctx]: next } };
    }),

  toggleBookmark: (bookmark) =>
    set((s) => {
      const ctx = s.connection.context ?? "";
      const list = s.bookmarksByContext[ctx] ?? [];
      if (list.some((b) => sameBookmark(b, bookmark))) {
        return {
          bookmarksByContext: {
            ...s.bookmarksByContext,
            [ctx]: list.filter((b) => !sameBookmark(b, bookmark)),
          },
        };
      }
      return {
        bookmarksByContext: { ...s.bookmarksByContext, [ctx]: [...list, bookmark] },
      };
    }),

  setClusterStatus: (status) => set({ clusterStatus: status }),
  setWatchCount: (n) => set({ watchCount: n }),
});
