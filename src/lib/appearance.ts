/**
 * Appearance preferences beyond the colour palette: UI font, accent colour, and
 * reduced motion.
 *
 * These live on `<html>` as `data-*` attributes, one knob each, and are applied
 * by the same store subscription that applies the theme (useTheme.ts) — so the
 * document is always correct before React renders anything that reads tokens.
 * The CSS that reacts to each attribute lives in tokens.css (font + accent) and
 * global.css (motion).
 *
 * The types and narrowers live here so settings.ts can sanitise them; the apply
 * functions live here too so the sync hook stays a one-line-per-knob switch.
 */

/** The app's UI font. "mono" is the design; "sans" re-values the font tokens. */
export type UiFont = "mono" | "sans";

/** The accent hue, applied to --accent/--accent-hover across every surface. */
export type Accent = "blue" | "green" | "purple" | "orange";

export const UI_FONTS: UiFont[] = ["mono", "sans"];
export const ACCENTS: Accent[] = ["blue", "green", "purple", "orange"];

/** Narrow arbitrary persisted junk to a UiFont, defaulting to the design font. */
export function asUiFont(value: unknown): UiFont {
  return UI_FONTS.includes(value as UiFont) ? (value as UiFont) : "mono";
}

/** Narrow arbitrary persisted junk to an Accent, defaulting to blue. */
export function asAccent(value: unknown): Accent {
  return ACCENTS.includes(value as Accent) ? (value as Accent) : "blue";
}

/** Set the UI font attribute; "mono" is explicit so the attr is always present. */
export function applyUiFont(font: UiFont): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.uiFont = font;
}

/** Set the accent hue attribute. */
export function applyAccent(accent: Accent): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.accent = accent;
}

/**
 * Toggle reduced motion: kills the pulsing "live" dot (the app's only animation)
 * and any transitions. Presence of the attribute is the state; absence is off.
 */
export function applyReducedMotion(reduced: boolean): void {
  if (typeof document === "undefined") return;
  if (reduced) {
    document.documentElement.dataset.reducedMotion = "true";
  } else {
    delete document.documentElement.dataset.reducedMotion;
  }
}
