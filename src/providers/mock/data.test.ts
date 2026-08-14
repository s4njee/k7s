/**
 * Tests for the demo custom-kind rows (B15/B30). The mock is a faithful mirror
 * of the backend's `map_dynamic`: for a kind with printer columns, each row's
 * cells must line up 1:1 with the columns `kindMeta` derives — NAME, NAMESPACE?,
 * the CRD's printer columns, then AGE.
 */

import { describe, expect, it } from "vitest";
import { buildCustomRows, MOCK_CUSTOM_KINDS, workloadPods } from "./data";
import { kindMeta } from "../../lib/kinds";

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
