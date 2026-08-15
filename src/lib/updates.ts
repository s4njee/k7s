/**
 * Automatic updates (B72).
 *
 * The frontend's only contact with tauri-plugin-updater. The store holds the
 * plain state the UI renders (version, status); the live Update handle is kept
 * module-scoped here because it isn't serializable and only one is ever in
 * flight.
 *
 * Everything here fails *quietly* — that's the design (B72 accepts: "airgapped
 * machines degrade to nothing, no error toasts on every launch"). Demo mode has
 * no Tauri runtime, a dev build has no update server, an airgapped machine has
 * no endpoint, and a tampered manifest fails signature verification — in every
 * case the app is simply "current" and no error reaches the UI.
 */

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-shell";
import { IS_DEMO } from "../providers";
import { useStore } from "../store";

/** The changelog on GitHub, where each release's notes live (B72 links here). */
export const CHANGELOG_URL = "https://github.com/s4njee/k7s/blob/main/CHANGELOG.md";

let pending: Update | null = null;

/** Passive check. Never throws; the caller can't tell why it "found nothing". */
export async function checkForUpdates(): Promise<void> {
  const setUpdate = useStore.getState().setUpdate;
  if (IS_DEMO) return; // no Tauri updater in a browser page
  setUpdate({ status: "checking" });
  try {
    const update = await check();
    if (!update) {
      pending = null;
      setUpdate({ status: "none", version: undefined, notes: undefined });
      return;
    }
    pending = update;
    setUpdate({ status: "available", version: update.version, notes: update.body ?? undefined });
  } catch {
    // Offline, no endpoint, dev build, or a signature that doesn't verify:
    // the app runs fine as-is. Stay silent.
    pending = null;
    setUpdate({ status: "idle", version: undefined, notes: undefined });
  }
}

/** Download and install the pending update; the running app restarts to apply it. */
export async function installUpdate(): Promise<void> {
  const setUpdate = useStore.getState().setUpdate;
  if (!pending) return;
  setUpdate({ status: "downloading" });
  try {
    await pending.downloadAndInstall();
    pending = null;
    setUpdate({ status: "installed" });
  } catch {
    // Download or install failed; the update is still offered, user can retry.
    setUpdate({ status: "available" });
  }
}

/** Restart the app so an installed update takes effect (B72: install-on-restart). */
export async function restartToApplyUpdate(): Promise<void> {
  try {
    await relaunch();
  } catch {
    // The update is already applied on disk; a manual restart finishes it.
  }
}

/** Open the changelog for the update notice's "what's new" link. */
export function openChangelog(): void {
  void open(CHANGELOG_URL).catch(() => {});
}
