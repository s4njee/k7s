/**
 * User settings (B23) and the rules for keeping them sane.
 *
 * These are typed into a text field and then fed to real loops — a ring buffer, a
 * poll interval, an exec command — so every value is clamped on the way in rather
 * than trusted. A cap of 0 would silently discard every log line; a 1ms poll
 * interval would hammer the API server. Bad input is corrected, never rejected:
 * the panel edits live, and yanking the field out from under someone mid-keystroke
 * is worse than briefly holding a value that gets clamped on blur.
 */

import { asTheme, type Theme } from "./theme";

/** Everything the settings panel controls. */
export interface Settings {
  /** Lines the log view retains (the design default is 200). */
  logBufferCap: number;
  /** Seconds between pod/node metrics polls. */
  metricsIntervalSecs: number;
  /** Seconds between cluster-status polls. */
  statusIntervalSecs: number;
  /** Namespace selected on connect; "all" for no filter. */
  defaultNamespace: string;
  /**
   * Command run when opening a shell. Empty means the built-in probe, which
   * prefers bash and falls back to sh.
   */
  shellCommand: string;
  /** Colour palette; "system" follows the OS (B52). */
  theme: Theme;
  /**
   * Image for the node debug shell (B53). Empty uses the built-in default.
   *
   * Worth exposing because the constraints are real and cluster-specific: the
   * image must be multi-arch on a mixed-arch cluster, must carry a full `nsenter`,
   * and on an air-gapped cluster must come from a registry the nodes can reach.
   */
  nodeShellImage: string;
}

export const DEFAULT_SETTINGS: Settings = {
  logBufferCap: 200,
  metricsIntervalSecs: 15,
  statusIntervalSecs: 10,
  defaultNamespace: "all",
  shellCommand: "",
  // Following the OS is the least surprising default, and it's what the app did
  // implicitly before there was a choice — for anyone on a dark desktop.
  theme: "system",
  nodeShellImage: "",
};

/**
 * Bounds for the numeric settings. The lower bounds are where the feature stops
 * working (a handful of log lines is useless; sub-5s polling is rude to the API
 * server); the upper bounds are where it stops being a setting and becomes a
 * memory leak or an effectively-frozen display.
 */
export const LIMITS = {
  logBufferCap: { min: 50, max: 5000 },
  metricsIntervalSecs: { min: 5, max: 300 },
  statusIntervalSecs: { min: 5, max: 300 },
} as const;

/**
 * What `sanitizeSettings` accepts: the same keys, but any value.
 *
 * Deliberately looser than `Partial<Settings>` — its callers are persisted JSON
 * and half-typed form fields, neither of which is typed by construction. Claiming
 * the input is already `Partial<Settings>` would put the cast at every call site
 * instead of inside the one function whose job is to check.
 */
export type SettingsInput = Partial<Record<keyof Settings, unknown>>;

/** Clamp a number into a range, falling back to `fallback` for junk input. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  // NaN/Infinity from an empty or half-typed field: keep the default rather than
  // writing garbage into a loop bound.
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Coerce anything (persisted prefs from an older version, a half-typed field)
 * into usable settings. Every field falls back to its default independently, so
 * one bad value can't discard the rest.
 */
export function sanitizeSettings(raw: SettingsInput | null | undefined): Settings {
  const s = raw ?? {};
  return {
    logBufferCap: clampNumber(
      s.logBufferCap,
      LIMITS.logBufferCap.min,
      LIMITS.logBufferCap.max,
      DEFAULT_SETTINGS.logBufferCap,
    ),
    metricsIntervalSecs: clampNumber(
      s.metricsIntervalSecs,
      LIMITS.metricsIntervalSecs.min,
      LIMITS.metricsIntervalSecs.max,
      DEFAULT_SETTINGS.metricsIntervalSecs,
    ),
    statusIntervalSecs: clampNumber(
      s.statusIntervalSecs,
      LIMITS.statusIntervalSecs.min,
      LIMITS.statusIntervalSecs.max,
      DEFAULT_SETTINGS.statusIntervalSecs,
    ),
    defaultNamespace:
      typeof s.defaultNamespace === "string" && s.defaultNamespace.trim() !== ""
        ? s.defaultNamespace.trim()
        : DEFAULT_SETTINGS.defaultNamespace,
    shellCommand: typeof s.shellCommand === "string" ? s.shellCommand.trim() : "",
    // Not a clamp: an unknown string (older prefs, hand-edited file) has no
    // nearest valid value, so it falls back to the default outright.
    theme: asTheme(s.theme),
    nodeShellImage: typeof s.nodeShellImage === "string" ? s.nodeShellImage.trim() : "",
  };
}
