/**
 * Tests for the demo custom-kind rows (B15/B30). The mock is a faithful mirror
 * of the backend's `map_dynamic`: for a kind with printer columns, each row's
 * cells must line up 1:1 with the columns `kindMeta` derives — NAME, NAMESPACE?,
 * the CRD's printer columns, then AGE.
 */

import { describe, expect, it } from "vitest";
import { buildCustomRows, buildKindRows, MOCK_CUSTOM_KINDS, workloadPods } from "./data";
import { deriveProblems } from "../../lib/problems";
import { kindMeta, KIND_ORDER } from "../../lib/kinds";
import type { Row } from "../types";

describe("buildCustomRows (B30 printer columns)", () => {
  it("aligns cells to the columns a kind's printer columns imply", () => {
    const id = "argoproj.io/applications";
    const rows = buildCustomRows(id);
    const meta = kindMeta(id, MOCK_CUSTOM_KINDS);
    // Columns: NAME, NAMESPACE, Sync Status, Health Status, AGE.
    expect(meta?.columns).toEqual(["NAME", "NAMESPACE", "Sync Status", "Health Status", "AGE"]);
    for (const row of rows) {
      expect(row.cells.length, row.name).toBe(meta!.columns.length);
    }
  });

  it("evaluates the printer columns from each object's status", () => {
    const rows = buildCustomRows("argoproj.io/applications");
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.cells]));
    // NAME, NAMESPACE, Sync Status, Health Status, AGE.
    expect(byName["valkyrie"]?.map((c) => c.text)).toEqual([
      "valkyrie", "argocd", "Synced", "Healthy", "31d",
    ]);
    // The case worth showing: synced but still rolling out.
    expect(byName["observability"]?.map((c) => c.text)).toEqual([
      "observability", "argocd", "Synced", "Progressing", "18d",
    ]);
  });

  it("keeps the generic NAME, AGE set for kinds without printer columns", () => {
    const rows = buildCustomRows("cert-manager.io/clusterissuers");
    const meta = kindMeta("cert-manager.io/clusterissuers", MOCK_CUSTOM_KINDS);
    // Cluster-scoped: no NAMESPACE, no printer columns → NAME, AGE.
    expect(meta?.columns).toEqual(["NAME", "AGE"]);
    expect(rows[0]?.cells.length).toBe(2);
  });
});

describe("workloadPods (B31 log bundle)", () => {
  it("resolves a demo Deployment to its real fixture pods", () => {
    const pods = workloadPods("valkyrie-api");
    expect(pods).toEqual(["valkyrie-api-7d9f8b64d-x2k4n", "valkyrie-api-7d9f8b64d-p9w7z"]);
  });

  it("resolves a StatefulSet by its ordinal-suffixed pods", () => {
    expect(workloadPods("yggdrasil-db")).toEqual(["yggdrasil-db-0", "yggdrasil-db-1"]);
  });

  it("falls back to two synthetic pods for a workload the fixture doesn't back", () => {
    const pods = workloadPods("report-gen");
    expect(pods.length).toBe(2);
    expect(pods[0]).toMatch(/^report-gen-/);
  });
});

describe("demo problems (B32)", () => {
  /** All built-in kinds' demo rows, as the store would hold them. */
  function mockRows(): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const kind of KIND_ORDER) {
      if (kind === "problems") continue;
      out[kind] = buildKindRows(kind);
    }
    return out;
  }

  it("derives the freya-style fixtures the mock was given", () => {
    const problems = deriveProblems(mockRows());

    // The demo data deliberately mirrors B32's freya story: a NotReady node, the
    // crash-looper, a stuck Terminating pod, a long-Pending pod, a failed job,
    // and Warning events.
    expect(problems.some((r) => r.cells[1].text === "Node" && r.cells[2].text === "freya-node-07")).toBe(true);
    expect(
      problems.some((r) => r.cells[1].text === "Pod" && r.cells[3].text === "CrashLoopBackOff"),
    ).toBe(true);
    expect(problems.some((r) => r.cells[3].text.startsWith("stuck Terminating"))).toBe(true);
    expect(problems.some((r) => r.cells[3].text.startsWith("Pending for"))).toBe(true);
    expect(problems.some((r) => r.cells[1].text === "Job")).toBe(true);
    expect(problems.some((r) => r.cells[1].text === "Event")).toBe(true);

    // The freshly-Pending canary (38s) is below the threshold — the derivation
    // must NOT flag it, so the threshold actually does something.
    expect(problems.some((r) => r.cells[2].text === "valkyrie-api-canary-89f7c5d4b-nn2kp")).toBe(false);

    // Everything is navigable.
    for (const p of problems) expect(p.involved).toBeDefined();
  });
});
