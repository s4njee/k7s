/**
 * Log view options (B29): which container generation to read, and how far back.
 *
 * Pure, so the mapping from what the toolbar shows to what the API is asked for
 * is testable — and so both the live stream and the export ask for the same thing.
 */

/** How far back the log read reaches. */
export type SinceOption = "all" | "5m" | "1h" | "24h";

/** In toolbar order, widest last — "all" is the default and reads leftmost. */
export const SINCE_OPTIONS: SinceOption[] = ["all", "5m", "1h", "24h"];

/**
 * Seconds for a window, or undefined for "all".
 *
 * undefined rather than 0: the API treats `sinceSeconds=0` as a real (empty)
 * window, so it has to be *absent* to mean no bound.
 */
export function sinceSeconds(option: SinceOption): number | undefined {
  switch (option) {
    case "5m":
      return 5 * 60;
    case "1h":
      return 60 * 60;
    case "24h":
      return 24 * 60 * 60;
    case "all":
      return undefined;
  }
}

/**
 * Whether "previous" is worth offering for a pod.
 *
 * A container that has never restarted has no previous generation, and asking for
 * one is a 400 ("previous terminated container not found"). Restarts are the
 * signal that there's something back there to read.
 */
export function hasPrevious(restarts: number | undefined): boolean {
  return (restarts ?? 0) > 0;
}

/** Filename offered when exporting, e.g. "wiki-6b6d775f4-djpwx.wiki.previous.log". */
export function exportFilename(pod: string, container: string, previous: boolean): string {
  // An empty container means the interleaved all-containers view (B7).
  const part = container === "" ? "all" : container;
  return `${pod}.${part}${previous ? ".previous" : ""}.log`;
}
