/**
 * Column-config helpers (B87): resolveColumns (visibility/order/custom/CLUSTER),
 * customCell (label/annotation/jsonpath with the "—" contract), and renderedCells.
 */

import { describe, expect, it } from "vitest";
import { customCell, renderedCells, resolveColumns, type ColumnPrefs } from "./columns";
import { buildPodRows } from "../providers/mock/data";
import { KIND_META } from "./kinds";

const POD_COLUMNS = KIND_META.pods.columns;
const prefs = (over: Partial<ColumnPrefs>): ColumnPrefs => ({ hidden: [], order: null, widths: {}, custom: [], ...over });

describe("resolveColumns", () => {
  it("defaults to every base column in order, CLUSTER pinned first", () => {
    const refs = resolveColumns(["CLUSTER", ...KIND_META.problems.columns]);
    expect(refs.map((r) => r.name)).toEqual(["CLUSTER", ...KIND_META.problems.columns]);
    expect(refs[0]).toEqual({ name: "CLUSTER", baseIndex: 0 });
    expect(refs[1].baseIndex).toBe(1); // SEVERITY sits at base cell index 1 in merged rows
  });

  it("hides columns by name and keeps the rest in order", () => {
    const refs = resolveColumns(POD_COLUMNS, prefs({ hidden: ["NAMESPACE"] }));
    expect(refs.map((r) => r.name)).not.toContain("NAMESPACE");
    expect(refs.map((r) => r.name)).toHaveLength(POD_COLUMNS.length - 1);
  });

  it("reorders base columns by the configured order, then appends the leftovers", () => {
    const refs = resolveColumns(POD_COLUMNS, prefs({ order: ["CPU", "MEM"] }));
    expect(refs.map((r) => r.name).slice(0, 2)).toEqual(["CPU", "MEM"]);
    // NAME/NAMESPACE/… come after, in the kind's natural order.
    expect(refs.map((r) => r.name)).toContain("NAME");
  });

  it("drops stale names (CRD printer columns change between connects)", () => {
    const refs = resolveColumns(POD_COLUMNS, prefs({ order: ["NAME", "NOT_A_COLUMN"] }));
    expect(refs.map((r) => r.name)).not.toContain("NOT_A_COLUMN");
    expect(refs.map((r) => r.name)[0]).toBe("NAME");
  });

  it("appends custom columns after the base ones, as baseIndex null", () => {
    const refs = resolveColumns(POD_COLUMNS, prefs({ custom: [{ id: "label:app", type: "label", name: "App", key: "app" }] }));
    const custom = refs[refs.length - 1];
    expect(custom).toMatchObject({ name: "App", baseIndex: null });
    expect(custom.custom).toMatchObject({ type: "label", key: "app" });
  });

  it("pins CLUSTER even when the config hides/reorders problems columns", () => {
    const refs = resolveColumns(["CLUSTER", ...KIND_META.problems.columns], prefs({ hidden: ["OBJECT"] }));
    expect(refs[0].name).toBe("CLUSTER");
    expect(refs.map((r) => r.name)).not.toContain("OBJECT");
  });
});

describe("customCell", () => {
  const pod = buildPodRows("freya")[0]; // carries labels: { app: … }

  it("renders a label value, with a numeric sort key when the value is a number", () => {
    expect(customCell(pod, { id: "label:app", type: "label", name: "App", key: "app" }).text).toBe(pod.labels?.app);
    const n = customCell(pod, { id: "label:x", type: "label", name: "X", key: "restarts" });
    // A numeric-looking label value gets a sort key.
    const numeric = customCell({ ...pod, labels: { ...pod.labels, restarts: "14" } }, { id: "label:r", type: "label", name: "R", key: "restarts" });
    expect(numeric).toMatchObject({ text: "14", sort: 14 });
    expect(n).toEqual({ text: "—", tone: "secondary" });
  });

  it("renders an annotation value, and — when missing", () => {
    const annotated = { ...pod, annotations: { owner: "team-a" } };
    expect(customCell(annotated, { id: "ann:owner", type: "annotation", name: "Owner", key: "owner" }).text).toBe("team-a");
    expect(customCell(pod, { id: "ann:owner", type: "annotation", name: "Owner", key: "owner" })).toEqual({ text: "—", tone: "secondary" });
  });

  it("renders a JSONPath column against the row's structured fields, — when missing", () => {
    expect(customCell(pod, { id: "jp:app", type: "jsonpath", name: "App", path: ".labels.app" }).text).toBe(pod.labels?.app);
    expect(customCell(pod, { id: "jp:ns", type: "jsonpath", name: "NS", path: ".namespace" }).text).toBe(pod.namespace);
    expect(customCell(pod, { id: "jp:nope", type: "jsonpath", name: "Nope", path: ".labels.nope" })).toEqual({ text: "—", tone: "secondary" });
  });
});

describe("renderedCells", () => {
  it("maps base cells (subset/order) and appends custom cells", () => {
    const pod = buildPodRows("freya")[0];
    const refs = resolveColumns(POD_COLUMNS, prefs({
      hidden: ["NAMESPACE"],
      custom: [{ id: "label:app", type: "label", name: "App", key: "app" }],
    }));
    const cells = renderedCells(pod, refs);
    expect(cells).toHaveLength(POD_COLUMNS.length - 1 + 1);
    expect(cells[0].text).toBe(pod.cells[0].text); // NAME
    expect(cells[cells.length - 1].text).toBe(pod.labels?.app); // custom App
  });
});
