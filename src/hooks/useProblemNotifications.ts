/**
 * Native problem notifications (B50): when a problem *transitions into* being a
 * problem — reusing B32's derivation over the store rows — and notifications
 * are opted in, show one native notification per object, debounced per object
 * and never while the window is focused.
 *
 * The diff is against the previous snapshot, so a pod that stays in err tone
 * notifies once, not every poll tick; the cooldown means a problem that
 * recovers and recurs within it stays quiet. Clicking the notification focuses
 * the window, which is caught here: the just-announced problem becomes the
 * navigation target the next time the window regains focus.
 */

import { useEffect } from "react";
import { useStore } from "../store";
import { getProvider } from "../providers";
import { deriveProblems } from "../lib/problems";
import { navIdForKind } from "../lib/kinds";
import type { Row } from "../providers/types";

/** One notification per object per this window, however it recurs. */
export const NOTIFY_COOLDOWN = 10 * 60 * 1000;

/**
 * The problems worth notifying now: ones that weren't in the previous snapshot
 * (a fresh transition into a problem state) and aren't within their cooldown.
 * Pure, so the "a crash-looper notifies once per cooldown" rule is testable.
 */
export function dueProblems(
  problems: Row[],
  prev: Set<string>,
  lastNotified: Map<string, number>,
  now: number,
  cooldown: number,
): Row[] {
  return problems.filter((p) => {
    if (prev.has(p.uid)) return false; // already a problem; not a transition
    return now - (lastNotified.get(p.uid) ?? 0) >= cooldown;
  });
}

export function useProblemNotifications(): void {
  const enabled = useStore((s) => s.settings.notifications);

  useEffect(() => {
    if (!enabled) return;
    let prev = new Set<string>();
    const lastNotified = new Map<string, number>();
    // The problem a notification was just shown for; a click that focuses the
    // window (or the user coming back to look) jumps to it.
    let pending: { kind: string; namespace?: string; name: string } | null = null;

    const notify = () => {
      // Never while the window is focused — you're already looking at it.
      if (typeof document !== "undefined" && document.hasFocus()) return;
      const s = useStore.getState();
      const problems = deriveProblems(s.rows);
      const now = Date.now();
      for (const p of dueProblems(problems, prev, lastNotified, now, NOTIFY_COOLDOWN)) {
        const inv = p.involved;
        if (!inv) continue;
        const kind = navIdForKind(inv.kind, inv.apiVersion, s.customKinds);
        if (!kind) continue;
        lastNotified.set(p.uid, now);
        pending = { kind, namespace: inv.namespace, name: inv.name };
        const reason = p.cells[3]?.text ?? p.cells[0]?.text ?? "problem";
        void getProvider().notifyProblem({ kind, namespace: inv.namespace, name: inv.name }, reason);
      }
      // Drop cooldown entries old enough to be forgotten, so the map can't grow
      // without bound on a long-running session.
      for (const [uid, at] of lastNotified) {
        if (now - at > NOTIFY_COOLDOWN * 2) lastNotified.delete(uid);
      }
      prev = new Set(problems.map((p) => p.uid));
    };

    // A notification click focuses the window; that focus change is our signal
    // to jump to the just-announced problem. Demo mode (no Tauri window) can't
    // be focused natively, so this is guarded and silently no-ops there.
    let offFocus: (() => void) | undefined;
    const setupFocus = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        offFocus = await getCurrentWindow().onFocusChanged(({ payload }) => {
          if (payload && pending) {
            useStore.getState().navigateTo(pending);
            pending = null;
          }
        });
      } catch {
        /* demo mode: no native window to watch */
      }
    };
    void setupFocus();

    const unsub = useStore.subscribe(notify);
    notify();
    return () => {
      unsub();
      offFocus?.();
    };
  }, [enabled]);
}
