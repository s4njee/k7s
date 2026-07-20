/**
 * Theme resolution and the token bridge (B52).
 *
 * CSS handles itself: `[data-theme="light"]` in tokens.css re-values every
 * variable, so anything styled with `var(--x)` follows for free. This module
 * exists for the two things that *can't* read CSS variables — xterm and plotly
 * both demand literal colors — plus the plumbing to decide which palette is on.
 *
 * The shape here is deliberate: `TERM_TOKENS`/`PLOT_TOKENS` are name→role maps,
 * and `buildTheme` is a pure function of a lookup. That keeps the interesting
 * part (which token feeds which slot) testable without a DOM, and means adding a
 * palette never touches this file.
 */

/** What the user picked. "system" follows the OS. */
export type Theme = "dark" | "light" | "system";
/** What's actually on screen — "system" is always resolved to one of these. */
export type ResolvedTheme = "dark" | "light";

export const THEMES: Theme[] = ["dark", "light", "system"];

/** Key for the paint-time cache. See `bootTheme` for why this isn't just prefs. */
export const THEME_STORAGE_KEY = "k7s.theme";

/** Narrow arbitrary persisted junk to a Theme, defaulting to "system". */
export function asTheme(value: unknown): Theme {
  return THEMES.includes(value as Theme) ? (value as Theme) : "system";
}

/** Resolve a preference against the OS setting. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "dark" || theme === "light") return theme;
  return prefersDark ? "dark" : "light";
}

// ---- the token bridge ----

/**
 * xterm slot → token name.
 *
 * `black` maps to its own token rather than to the background: in dark those are
 * the same color (the usual terminal convention), but reusing the background in
 * light would render black text as invisible-on-white.
 */
export const TERM_TOKENS = {
  background: "--bg-terminal",
  foreground: "--text-body",
  cursor: "--accent",
  selectionBackground: "--editor-selection",
  black: "--ansi-black",
  brightBlack: "--text-faint",
  red: "--status-err",
  green: "--status-ok",
  yellow: "--status-warn",
  blue: "--accent",
  magenta: "--ansi-magenta",
  cyan: "--ansi-cyan",
  white: "--text-body",
} as const;

/** Plotly slot → token name. */
export const PLOT_TOKENS = {
  surface: "--bg-terminal",
  axis: "--text-secondary",
  grid: "--border-default",
  accent: "--accent",
  ok: "--status-ok",
  warn: "--status-warn",
  err: "--status-err",
  accent2: "--accent-hover",
} as const;

/** Fallbacks matching the dark palette, used when no computed style is available. */
const FALLBACK: Record<string, string> = {
  "--bg-terminal": "#0a0a0c",
  "--text-body": "#d2d2d8",
  "--text-secondary": "#a4a4ae",
  "--text-faint": "#57575f",
  "--border-default": "#26262b",
  "--accent": "#4d9fff",
  "--accent-hover": "#7db8ff",
  "--status-ok": "#9ece6a",
  "--status-warn": "#e0af68",
  "--status-err": "#f7768e",
  "--ansi-black": "#0a0a0c",
  "--ansi-magenta": "#bb9af7",
  "--ansi-cyan": "#7dcfff",
  "--editor-selection": "#23324a",
};

/** Turn a slot→token map into a slot→color map, given a token lookup. Pure. */
export function buildTheme<T extends Record<string, string>>(
  tokens: T,
  get: (name: string) => string,
): Record<keyof T, string> {
  const out = {} as Record<keyof T, string>;
  for (const slot of Object.keys(tokens) as (keyof T)[]) {
    const name = tokens[slot];
    // A token that resolves to nothing (typo, or a palette that forgot it) would
    // hand xterm/plotly an empty string and render a black-on-black surprise;
    // the dark value is a bad look in light mode but always legible.
    out[slot] = get(name).trim() || FALLBACK[name] || "";
  }
  return out;
}

/**
 * A token colour at partial opacity, as `rgba(...)`.
 *
 * Plotly needs literal fill colours and understands no `color-mix()`, so the
 * translucent area fills under the metric lines are mixed here instead. Only
 * `#rgb`/`#rrggbb` are handled — that's what tokens.css uses, and silently
 * mangling an unexpected format would be worse than passing it through.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * Read a custom property as an actual color.
 *
 * Prefer `el` when the caller sits inside a scoped surface (light-mode dark
 * panels redefine tokens on `[data-surface="panel"]`). Falling back to <html>
 * keeps the document palette for anything outside those islands.
 */
export function readToken(name: string, el?: Element | null): string {
  if (typeof document === "undefined") return FALLBACK[name] ?? "";
  const target = el ?? document.documentElement;
  return getComputedStyle(target).getPropertyValue(name);
}

/** The xterm `theme` object for the live token surface (pass the terminal host). */
export function termTheme(el?: Element | null): Record<string, string> {
  return buildTheme(TERM_TOKENS, (name) => readToken(name, el));
}

/** The plotly colors for the live token surface (pass a host inside the panel). */
export function plotColors(el?: Element | null): Record<keyof typeof PLOT_TOKENS, string> {
  return buildTheme(PLOT_TOKENS, (name) => readToken(name, el));
}

// ---- applying ----

const MEDIA = "(prefers-color-scheme: dark)";

/** Does the OS want dark right now? */
export function prefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(MEDIA).matches;
}

/**
 * Put a palette on the document and cache it for the next launch.
 *
 * The cache is what stops the window flashing dark before React has asked the
 * backend for prefs — see `bootTheme`, which reads it synchronously.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolved;
  // Makes the webview's own widgets (native scrollbars, form controls, and the
  // default canvas behind the app) match, which CSS variables can't reach.
  document.documentElement.style.colorScheme = resolved;
}

/** Persist the *choice* for the paint-time cache. Prefs remain canonical. */
export function cacheTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / disabled storage: the cache is an optimisation, not state.
  }
}

/** Read the cached choice, for use before prefs have loaded. */
export function cachedTheme(): Theme {
  try {
    return asTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/**
 * Subscribe to OS theme changes. Only meaningful while the pref is "system",
 * but the caller keeps the subscription live and re-resolves, so switching
 * to/from "system" needs no resubscribe dance.
 */
export function onSystemThemeChange(cb: (dark: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(MEDIA);
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
