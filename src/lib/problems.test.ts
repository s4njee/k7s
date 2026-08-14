/**
 * Tests for the problems derivation (B32) — one case per source, plus the
 * healthy-cluster → empty guarantee. Rows are built with the exact cell layouts
 * the backend mappers produce (see src-tauri mappers.rs).
 */

import { describe, expect, it } from "vitest";
import { deriveProblems } from "./problems";
import type { Cell, Row } from "../providers/types";

/** A fixed "now" reference: rows' AGE cells are timestamps relative to this. */
const NOW = Date.parse("2026-08-14T12:00:00Z");

const AGE_CELL = (secsAgo: number): Cell => ({
  text: new Date(NOW - secsAgo * 1000).toISOString(),
  tone: "muted",
  format: "age",
});

/** Minimal row: uid + the given cells (NAME cell + the rest). */
function mk(uid: string, name: string, cells: Cell[], extra: Partial<Row> = {}): Row {
  return { uid, name, cells, ...extra };
}

/** The rows the derivation scans, keyed by kind; empty map = healthy. */
function rows(partial: Record<string, Row[]>): Record<string, Row[]> {
  return partial;
}

/** Derive against the fixed clock, so the age thresholds are deterministic. */
function derive(r: Record<string, Row[]>): Row[] {
  return deriveProblems(r, NOW);
}

describe("deriveProblems sources", () => {
  it("flags a NotReady node", () => {
    const out = derive(
      rows({
        nodes: [
          mk("n1", "mars", [
            { text: "mars", tone: "primary" },
            { text: "NotReady", tone: "err" },
            { text: "worker", tone: "secondary" },
          ]),
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0].cells.map((c) => c.text)).toEqual(["error", "Node", "mars", "NotReady", "—"]);
    expect(out[0].cells[0].tone).toBe("err");
    expect(out[0].involved).toEqual({ kind: "Node", name: "mars" });
  });

  it("flags a pod with err tone (CrashLoopBackOff)", () => {
    const out = derive(
      rows({
        pods: [
          mk("p1", "heimdall", [
            { text: "heimdall", tone: "primary" },
            { text: "prod", tone: "muted" },
            { text: "1/2", tone: "warn" },
            { text: "14", tone: "secondary" },
            { text: "—", tone: "secondary" },
            { text: "—", tone: "secondary" },
            AGE_CELL(60 * 60),
            { text: "CrashLoopBackOff", tone: "err", dot: true },
          ], { namespace: "prod" }),
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0].cells.map((c) => c.text)).toEqual([
      "error", "Pod", "heimdall", "CrashLoopBackOff", AGE_CELL(3600).text,
    ]);
    expect(out[0].involved?.namespace).toBe("prod");
  });

  it("flags a pod stuck Pending past the threshold", () => {
    const out = derive(
      rows({
        pods: [
          mk("p1", "postgres", [
            { text: "postgres", tone: "primary" },
            { text: "prod", tone: "muted" },
            { text: "0/1", tone: "warn" },
            { text: "0", tone: "secondary" },
            { text: "—", tone: "secondary" },
            { text: "—", tone: "secondary" },
            AGE_CELL(20 * 60),
            { text: "Pending", tone: "warn", dot: true },
          ], { namespace: "prod" }),
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0].cells.map((c) => c.text)).toEqual([
      "warning", "Pod", "postgres", "Pending for 20m", AGE_CELL(1200).text,
    ]);
  });

  it("does NOT flag a freshly-Pending pod (normal scheduling)", () => {
    const out = derive(
      rows({
        pods: [
          mk("p1", "canary", [
            { text: "canary", tone: "primary" },
            { text: "staging", tone: "muted" },
            { text: "0/1", tone: "warn" },
            { text: "0", tone: "secondary" },
            { text: "—", tone: "secondary" },
            { text: "—", tone: "secondary" },
            AGE_CELL(38),
            { text: "Pending", tone: "warn", dot: true },
          ], { namespace: "staging" }),
        ],
      }),
    );
    expect(out).toEqual([]);
  });

  it("flags a pod stuck Terminating past the threshold", () => {
    const out = derive(
      rows({
        pods: [
          mk("p1", "stuck", [
            { text: "stuck", tone: "primary" },
            { text: "prod", tone: "muted" },
            { text: "0/1", tone: "warn" },
            { text: "0", tone: "secondary" },
            { text: "—", tone: "secondary" },
            { text: "—", tone: "secondary" },
            AGE_CELL(3 * 60),
            { text: "Terminating", tone: "warn", dot: true },
          ], { namespace: "prod" }),
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0].cells[3].text).toBe("stuck Terminating for 3m");
  });

  it("flags a degraded Deployment (ready < desired)", () => {
    const out = derive(
      rows({
        deployments: [
          mk("d1", "api", [
            { text: "api", tone: "primary" },
            { text: "prod", tone: "muted" },
            { text: "1/3", tone: "warn" },
            { text: "2", tone: "secondary" },
            { text: "1", tone: "secondary" },
            AGE_CELL(3600),
          ], { namespace: "prod" }),
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0].cells.map((c) => c.text)).toEqual([
      "warning", "Deployment", "api", "1/3 ready", AGE_CELL(3600).text,
    ]);
  });

  it("flags a failed Job via its backend flag", () => {
    const out = derive(
      rows({
        jobs: [
          mk("j1", "migrate", [
            { text: "migrate", tone: "primary" },
            { text: "prod", tone: "muted" },
            { text: "0/1", tone: "warn" },
            { text: "42s", tone: "secondary" },
            AGE_CELL(3600),
          ], { namespace: "prod", job: { failed: true } }),
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0].cells.map((c) => c.text)).toEqual([
      "error", "Job", "migrate", "job failed", AGE_CELL(3600).text,
    ]);
  });

  it("ignores a Job still running (not failed)", () => {
    const out = derive(
      rows({
        jobs: [
          mk("j1", "migrate", [
            { text: "migrate", tone: "primary" },
            { text: "prod", tone: "muted" },
            { text: "0/1", tone: "warn" },
            { text: "—", tone: "secondary" },
            AGE_CELL(60),
          ], { namespace: "prod", job: { failed: false } }),
        ],
      }),
    );
    expect(out).toEqual([]);
  });

  it("flags Warning events, navigable to the object they're about", () => {
    const out = derive(
      rows({
        events: [
          mk("e1", "e.17c", [
            { text: "Warning", tone: "err" },
            { text: "FailedMount", tone: "primary" },
            { text: "Pod/wiki-abc", tone: "secondary" },
            { text: "prod", tone: "muted" },
            AGE_CELL(300),
            { text: "×9", tone: "secondary" },
            { text: "MountVolume.SetUp failed for volume reports", tone: "secondary" },
          ], {
            namespace: "prod",
            involved: { kind: "Pod", name: "wiki-abc", namespace: "prod" },
          }),
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0].cells[1].text).toBe("Event");
    expect(out[0].cells[3].text).toBe("MountVolume.SetUp failed for volume reports");
    expect(out[0].involved).toEqual({ kind: "Pod", name: "wiki-abc", namespace: "prod" });
  });

  it("ignores Normal events", () => {
    const out = derive(
      rows({
        events: [
          mk("e1", "e.17c", [
            { text: "Normal", tone: "ok" },
            { text: "Scheduled", tone: "primary" },
            { text: "Pod/wiki-abc", tone: "secondary" },
            { text: "prod", tone: "muted" },
            AGE_CELL(60),
            { text: "×1", tone: "secondary" },
            { text: "assigned to freya-node-02", tone: "secondary" },
          ], { namespace: "prod", involved: { kind: "Pod", name: "wiki-abc", namespace: "prod" } }),
        ],
      }),
    );
    expect(out).toEqual([]);
  });
});

describe("deriveProblems ordering and health", () => {
  it("orders red (err) before amber (warn), then newest first", () => {
    const out = derive(
      rows({
        nodes: [mk("n1", "mars", [{ text: "mars", tone: "primary" }, { text: "NotReady", tone: "err" }, { text: "worker", tone: "secondary" }])],
        pods: [
          mk("p1", "oldpending", [
            { text: "oldpending", tone: "primary" },
            { text: "prod", tone: "muted" },
            { text: "0/1", tone: "warn" },
            { text: "0", tone: "secondary" },
            { text: "—", tone: "secondary" },
            { text: "—", tone: "secondary" },
            AGE_CELL(60 * 60),
            { text: "Pending", tone: "warn", dot: true },
          ]),
        ],
      }),
    );
    expect(out.map((r) => r.cells[0].tone)).toEqual(["err", "warn"]);
  });

  it("a healthy cluster yields no problems", () => {
    expect(derive(rows({}))).toEqual([]);
    expect(
      derive(
        rows({
          nodes: [mk("n1", "mars", [{ text: "mars", tone: "primary" }, { text: "Ready", tone: "ok" }, { text: "worker", tone: "secondary" }])],
          pods: [
            mk("p1", "ok", [
              { text: "ok", tone: "primary" },
              { text: "prod", tone: "muted" },
              { text: "1/1", tone: "secondary" },
              { text: "0", tone: "secondary" },
              { text: "—", tone: "secondary" },
              { text: "—", tone: "secondary" },
              AGE_CELL(3600),
              { text: "Running", tone: "ok", dot: true },
            ]),
          ],
          deployments: [
            mk("d1", "api", [
              { text: "api", tone: "primary" },
              { text: "prod", tone: "muted" },
              { text: "2/2", tone: "secondary" },
              { text: "2", tone: "secondary" },
              { text: "2", tone: "secondary" },
              AGE_CELL(3600),
            ]),
          ],
        }),
      ),
    ).toEqual([]);
  });
});
