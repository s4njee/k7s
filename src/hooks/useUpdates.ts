/**
 * Passive update checking (B72): once on mount, then once a day. Never blocks,
 * never nags — failures are silent (see lib/updates.ts). Components read the
 * resulting state from the store; this hook only triggers the checks and fills
 * in the running app's version for the Settings panel.
 */

import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { IS_DEMO } from "../providers";
import { useStore } from "../store";
import { checkForUpdates } from "../lib/updates";

/** The "surfaces the update within a day" clause of B72's acceptance. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function useUpdates() {
  useEffect(() => {
    if (IS_DEMO) return; // no Tauri runtime; nothing to check
    let alive = true;

    // Version badge in Settings ("Software updates" section).
    getVersion()
      .then((v) => {
        if (alive) useStore.getState().setUpdate({ currentVersion: v });
      })
      .catch(() => {}); // demo/browser: leave the version "—"

    void checkForUpdates();
    const timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
}
