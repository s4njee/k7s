/**
 * Applying the appearance — the colour palette plus the font/accent/motion
 * knobs — and keeping it in sync (B52).
 *
 * The apply deliberately happens *outside* React, via a store subscription set up
 * by `startAppearanceSync`. It used to be a `useEffect` in the app root, which is
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
  applyAccent,
  applyReducedMotion,
  applyUiFont,
  type Accent,
  type UiFont,
} from "../lib/appearance";
import {
  applyTheme,
  cacheTheme,
  onSystemThemeChange,
  resolveTheme,
  type ResolvedTheme,
} from "../lib/theme";

/**
 * Start applying the appearance: the colour palette plus the font, accent and
 * motion knobs. Call once, before the first render.
 *
 * Returns an unsubscribe, which nothing uses in the app (the subscription lives
 * as long as the document) but which keeps this testable.
 */
export function startAppearanceSync(): () => void {
  let lastTheme: ResolvedTheme | null = null;
  let lastFont: UiFont | null = null;
  let lastAccent: Accent | null = null;
  let lastMotion: boolean | null = null;
  const apply = () => {
    const s = useStore.getState();
    const resolved = resolveTheme(s.settings.theme, s.systemDark);
    if (resolved !== lastTheme) {
      lastTheme = resolved;
      applyTheme(resolved);
    }
    // Font/accent/motion are simple data-attribute switches; each fires only on
    // change, so a settings edit applies once, not on every store update.
    if (s.settings.uiFont !== lastFont) {
      lastFont = s.settings.uiFont;
      applyUiFont(s.settings.uiFont);
    }
    if (s.settings.accent !== lastAccent) {
      lastAccent = s.settings.accent;
      applyAccent(s.settings.accent);
    }
    if (s.settings.reduceMotion !== lastMotion) {
      lastMotion = s.settings.reduceMotion;
      applyReducedMotion(s.settings.reduceMotion);
    }
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
