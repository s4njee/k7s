/**
 * Applying the colour palette and keeping it in sync (B52).
 *
 * The apply deliberately happens *outside* React, via a store subscription set up
 * by `startThemeSync`. It used to be a `useEffect` in the app root, which is
 * subtly wrong: React runs child effects before parent effects, so a component
 * that reads tokens as literals (MetricsTab, ShellTab) would run its own effect
 * against the *previous* palette and render one frame of dark plots on a white
 * panel. A store subscription fires synchronously inside `set()`, before React
 * re-renders anything, so the document is always correct by the time any effect
 * looks at it.
 */

import { useEffect } from "react";
import { useStore } from "../store";
import { getProvider } from "../providers";
import {
  applyTheme,
  cacheTheme,
  onSystemThemeChange,
  resolveTheme,
  type ResolvedTheme,
} from "../lib/theme";

/**
 * Start applying the palette. Call once, before the first render.
 *
 * Returns an unsubscribe, which nothing uses in the app (the subscription lives
 * as long as the document) but which keeps this testable.
 */
export function startThemeSync(): () => void {
  let last: ResolvedTheme | null = null;
  const apply = () => {
    const s = useStore.getState();
    const resolved = resolveTheme(s.settings.theme, s.systemDark);
    if (resolved === last) return;
    last = resolved;
    applyTheme(resolved);
  };
  apply();
  return useStore.subscribe(apply);
}

/**
 * The palette on screen right now, without side effects.
 *
 * Canvas widgets (xterm, plotly) read tokens as literals, so they need to know
 * *when* the palette changed in order to re-read them. Depending on this value is
 * what turns a CSS-only change into one they notice.
 */
export function useResolvedTheme(): ResolvedTheme {
  const theme = useStore((s) => s.settings.theme);
  const systemDark = useStore((s) => s.systemDark);
  return resolveTheme(theme, systemDark);
}

/**
 * Track the OS colour scheme and cache the user's choice. Call once, from the
 * app root.
 *
 * The OS subscription stays attached even when the pref is "dark" or "light":
 * re-resolving is cheap, and dropping the listener would mean that the moment you
 * switch back to "system" you're stale until the OS next flips — which, on a
 * machine that flips at sunset, could be hours.
 */
export function useTheme(): ResolvedTheme {
  const theme = useStore((s) => s.settings.theme);
  const setSystemDark = useStore((s) => s.setSystemDark);

  const resolved = useResolvedTheme();

  useEffect(() => onSystemThemeChange(setSystemDark), [setSystemDark]);

  // Native window chrome (titlebar, native scrollbars) — CSS can't reach it.
  useEffect(() => {
    void getProvider().setWindowTheme(resolved);
  }, [resolved]);

  // Cache the *choice*, not the resolution: "system" must stay "system" across a
  // relaunch, or a machine that happened to be dark at quit would be pinned dark.
  useEffect(() => {
    cacheTheme(theme);
  }, [theme]);

  return resolved;
}
