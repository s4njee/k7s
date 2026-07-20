/**
 * Mock log-line generator — ported from the prototype's `makeLog`. Emits lines
 * from one of two pools (a CrashLoopBackOff pod gets error-heavy output, everything
 * else gets normal request logs), on a ~900ms cadence in the MockProvider.
 */

import type { LogLine } from "../types";
import { MOCK_PODS } from "./data";

type Pool = ReadonlyArray<readonly [LogLine["level"], string]>;

/** Error-heavy pool used for CrashLoopBackOff pods (prototype). */
const CRASH_POOL: Pool = [
  ["ERROR", "connection refused: dial tcp 10.96.14.30:6379 (auth token cache)"],
  ["ERROR", "panic recovered: nil pointer in session.Validate — restarting handler"],
  ["WARN", "retry 4/5 for upstream token exchange, backoff 8s"],
  ["INFO", "starting heimdall-auth v2.4.1 (commit 9f2ec1a)"],
  ["ERROR", "liveness probe will fail: dependency check timed out after 5s"],
];

/** Normal request-log pool for healthy pods (prototype). */
const NORMAL_POOL: Pool = [
  ["INFO", "GET /v1/valkyries/roster 200 12ms trace=8f2c1a"],
  ["INFO", "POST /v1/flights 201 34ms trace=b91e02"],
  ["INFO", "GET /healthz 200 1ms"],
  ["DEBUG", "cache hit ratio=0.94 keys=18234 evictions=0"],
  ["INFO", "GET /v1/valkyries/551/loadout 200 18ms trace=77ac1f"],
  ["WARN", "slow query: SELECT * FROM missions WHERE realm=$1 (412ms)"],
  ["INFO", "grpc unary /odin.Dispatch/Assign ok 9ms"],
  ["DEBUG", "wal checkpoint complete lsn=0/8F2A1C40"],
  ["INFO", "PUT /v1/flights/2214/status 200 22ms trace=cd120e"],
  ["ERROR", "context deadline exceeded calling mimir-cache (fallback to db)"],
];

/**
 * Produce one mock log line for the given pod at the given time.
 * @param podName selected pod (chooses the pool via its status)
 * @param date    timestamp for the line (defaults to now)
 */
export function makeLogLine(podName: string | null, date: Date = new Date()): LogLine {
  const pod = MOCK_PODS.find((p) => p.name === podName) ?? MOCK_PODS[0];
  const pool = pod.status === "CrashLoopBackOff" ? CRASH_POOL : NORMAL_POOL;
  const [level, msg] = pool[Math.floor(Math.random() * pool.length)];
  // Prototype uses ISO slice(11,23) → "HH:MM:SS.mmm".
  const ts = date.toISOString().slice(11, 23);
  return { ts, level, msg };
}

/** Seed the log view with N historical lines spaced ~1.4s apart (prototype seeds 30). */
export function seedLogLines(podName: string | null, count = 30): LogLine[] {
  const now = Date.now();
  const lines: LogLine[] = [];
  for (let i = count; i > 0; i--) {
    lines.push(makeLogLine(podName, new Date(now - i * 1400)));
  }
  return lines;
}
