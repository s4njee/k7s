/**
 * Maps a cell {@link Tone} to its design-token CSS variable. This is the *only*
 * place tone becomes color on the frontend — the backend/mock decide tone, the
 * table renders it. Keeps status coloring consistent across every table and the
 * detail panel.
 */

import type { Tone } from "../providers/types";

const TONE_VAR: Record<Tone, string> = {
  primary: "var(--text-primary)",
  secondary: "var(--text-secondary)",
  muted: "var(--text-muted)",
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  err: "var(--status-err)",
};

/** CSS color value for a tone. */
export function toneColor(tone: Tone): string {
  return TONE_VAR[tone];
}
