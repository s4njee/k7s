/**
 * How a node drain reads in the UI (B20).
 *
 * Pure, and separate from the banner that renders it, because the interesting
 * part is a judgement rather than markup: a PodDisruptionBudget block is *not* a
 * failure. It means evicting that pod right now would take its workload below the
 * availability its owner declared — the cluster protecting itself, working as
 * intended. Painting that red would train you to ignore red.
 */

import type { DrainProgress } from "../providers/types";
import type { Tone } from "../providers/types";

/**
 * The tone for a drain's current state:
 *   err   — something actually went wrong
 *   warn  — held back by a PDB (expected, but needs a decision)
 *   ok    — finished cleanly
 *   secondary — still working
 *
 * Real errors outrank PDB blocks: if both happened, the error is the thing to
 * look at.
 */
export function drainTone(p: DrainProgress): Tone {
  if (p.failures.some((f) => !f.blockedByPdb)) return "err";
  if (p.failures.some((f) => f.blockedByPdb)) return "warn";
  return p.done ? "ok" : "secondary";
}

/** Headline for the banner, e.g. "draining: 3/12 evicted". */
export function drainSummary(p: DrainProgress): string {
  return `${p.done ? "drain finished" : "draining"}: ${p.evicted}/${p.total} evicted`;
}

/** Pods a PodDisruptionBudget is holding back. */
export function pdbBlocked(p: DrainProgress) {
  return p.failures.filter((f) => f.blockedByPdb);
}

/** Pods that failed for a real reason. */
export function drainErrors(p: DrainProgress) {
  return p.failures.filter((f) => !f.blockedByPdb);
}
