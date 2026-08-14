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

/**
 * A deterministic colour for a named log source (a pod, in the workload bundle —
 * B31). Hashes the name to a hue at a fixed saturation/lightness that reads on
 * both themes, so a pod keeps the same tint for the life of the stream and two
 * pods in one Deployment don't collide.
 */
export function sourceColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 62% 52%)`;
}

/**
 * The distinctive short form of a pod name for a tag column: the suffix after
 * the last "-" — "x2k4n" from "wiki-abc123-x2k4n", "0" from "db-0". Replica
 * suffixes are what tell a workload's pods apart; the full name lives in a
 * tooltip.
 */
export function shortPod(name: string): string {
  const i = name.lastIndexOf("-");
  return i === -1 ? name : name.slice(i + 1);
}
