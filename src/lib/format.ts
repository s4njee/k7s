/**
 * Formatting helpers for Kubernetes-style display values: ages, CPU, and memory.
 *
 * These mirror the strings kubectl/Lens produce and the exact samples in the
 * prototype ("4d2h", "212m", "486Mi", "3.2Gi"). They are unit-tested in
 * format.test.ts against those samples.
 */

/**
 * Format a duration (given a creation timestamp) as a compact k8s age.
 *
 * kubectl's rules, reproduced: show at most two units, and once the age is large
 * the finer unit is dropped:
 *   < 1m            → "38s"
 *   < 1h            → "5m" (seconds dropped once we're past a minute... but k8s
 *                     keeps seconds only under 10m; we follow the common "2h14m"
 *                     style seen in the prototype)
 * The prototype shows "38s", "2h14m", "4d2h", "31d" — i.e.:
 *   seconds only              when < 60s          → "38s"
 *   minutes(+seconds)         when < 60m          → "2m" / "2m14s"
 *   hours(+minutes)           when < 24h          → "2h14m"
 *   days(+hours)              when < ~8d          → "4d2h"
 *   days only                 when large          → "31d"
 *
 * @param creationTs RFC3339 / ISO timestamp string.
 * @param now        Reference time (defaults to Date.now()); injectable for tests.
 */
export function formatAge(creationTs: string, now: number = Date.now()): string {
  const start = new Date(creationTs).getTime();
  if (Number.isNaN(start)) return "";

  // Clamp negatives (clock skew) to zero.
  let secs = Math.max(0, Math.floor((now - start) / 1000));

  const DAY = 86400;
  const HOUR = 3600;
  const MIN = 60;

  if (secs < MIN) {
    return `${secs}s`;
  }
  if (secs < HOUR) {
    const m = Math.floor(secs / MIN);
    const s = secs % MIN;
    // Show seconds only for the first 10 minutes (matches kubectl's finer detail).
    return m < 10 && s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  if (secs < DAY) {
    const h = Math.floor(secs / HOUR);
    const m = Math.floor((secs % HOUR) / MIN);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(secs / DAY);
  // For the first week, append the remaining hours ("4d2h"); after that, days only.
  if (d < 8) {
    const h = Math.floor((secs % DAY) / HOUR);
    return h > 0 ? `${d}d${h}h` : `${d}d`;
  }
  return `${d}d`;
}

/**
 * Format CPU from milli-cores to the k8s-style string.
 * Values < 1000m stay in millis ("212m"); larger values become cores ("1.5").
 */
export function formatCpu(milliCores: number): string {
  if (!Number.isFinite(milliCores) || milliCores < 0) return "—";
  if (milliCores < 1000) return `${Math.round(milliCores)}m`;
  // One decimal of cores, trimming a trailing ".0".
  const cores = milliCores / 1000;
  return Number.isInteger(cores) ? `${cores}` : cores.toFixed(1);
}

/**
 * Parse a CPU string ("212m", "1.5", "500000000n") back to milli-cores. Inverse of
 * {@link formatCpu}; used to build sort keys for mock rows (real rows get the raw
 * millis from the metrics feed). Returns undefined for unknown/em-dash values.
 */
export function parseCpuMillis(s: string): number | undefined {
  if (!s || s === "—") return undefined;
  const v = parseFloat(s);
  if (Number.isNaN(v)) return undefined;
  if (s.endsWith("m")) return v;
  if (s.endsWith("u")) return v / 1e3;
  if (s.endsWith("n")) return v / 1e6;
  return v * 1000; // bare number is cores
}

/**
 * Parse a memory string ("486Mi", "3.2Gi", "1000k") back to bytes. Inverse of
 * {@link formatMem}; used for mock sort keys. Returns undefined for "—"/unknown.
 */
export function parseMemBytes(s: string): number | undefined {
  if (!s || s === "—") return undefined;
  const v = parseFloat(s);
  if (Number.isNaN(v)) return undefined;
  const unit = s.replace(/[0-9.\s]/g, "");
  const mult: Record<string, number> = {
    "": 1,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  return v * (mult[unit] ?? 1);
}

/**
 * Format a byte count as a binary (Mi/Gi) memory string, matching kubectl.
 * Uses Mi under 1 GiB ("486Mi") and Gi with one decimal above ("3.2Gi").
 */
export function formatMem(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const Ki = 1024;
  const Mi = Ki * 1024;
  const Gi = Mi * 1024;

  if (bytes >= Gi) {
    const g = bytes / Gi;
    return Number.isInteger(g) ? `${g}Gi` : `${g.toFixed(1)}Gi`;
  }
  // Round to whole MiB (kubectl shows integer Mi at this scale).
  return `${Math.round(bytes / Mi)}Mi`;
}
