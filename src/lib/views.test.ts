/**
 * Saved-view helpers (B60): the id slugger, the sort-name→index resolution
 * (which must survive the all-clusters problems CLUSTER-prepend), and the built-in
 * views' filter expressions matching the rows they're named for.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_VIEWS, viewId, viewSortIndex, type SavedView } from "./views";
import { buildKindRows, buildPodRows } from "../providers/mock/data";
import { KIND_META } from "./kinds";
import { matchesFilter, parseFilter } from "./filter";
import type { Row } from "../providers/types";

const view = (over: Partial<SavedView>): SavedView => ({
  id: "v",
  name: "v",
  kind: "pods",
  namespace: "all",
  filter: "",
  sortColName: null,
  sortDir: "asc",
  ...over,
});

describe("viewId", () => {
  it("slugs a name deterministically", () => {
    expect(viewId("CrashLoopBackOff pods")).toBe("crashloopbackoff-pods");
    expect(viewId("Recent failures")).toBe("recent-failures");
  });
});

describe("viewSortIndex", () => {
  const POD_COLUMNS = KIND_META.pods.columns;

  it("resolves a column name to its index", () => {
    expect(viewSortIndex(view({ sortColName: "RESTARTS" }), POD_COLUMNS)).toBe(3);
    expect(viewSortIndex(view({ sortColName: "STATUS" }), POD_COLUMNS)).toBe(7);
  });

  it("resolves against the RENDERED columns (the caller already pins CLUSTER)", () => {
    const failures = view({
      kind: "problems",
      problemsScope: "all",
      sortColName: "REASON",
    });
    // Base problems columns are [SEVERITY, KIND, OBJECT, REASON, AGE]; the
    // rendered list (via B87's resolveColumns) is [CLUSTER, …], so REASON is 4.
    expect(viewSortIndex(failures, ["CLUSTER", ...KIND_META.problems.columns])).toBe(4);
  });

  it("is case-insensitive and returns null for an unknown or absent column", () => {
    expect(viewSortIndex(view({ sortColName: "restarts" }), POD_COLUMNS)).toBe(3);
    expect(viewSortIndex(view({ sortColName: "NOPE" }), POD_COLUMNS)).toBe(null);
    expect(viewSortIndex(view({ sortColName: null }), POD_COLUMNS)).toBe(null);
  });
});

describe("built-in views match the rows they're named for", () => {
  it("Unhealthy pods matches CrashLoopBackOff pods, not Running ones", () => {
    const b = BUILTIN_VIEWS.find((v) => v.id === "builtin-unhealthy-pods")!;
    const rows = buildPodRows("freya");
    const heimdall = rows.find((r) => r.name === "heimdall-auth-6b8c9d5f7-qq3rt")!;
    const running = rows.find((r) => r.name === "valkyrie-api-7d9f8b64d-x2k4n")!;
    expect(matchesFilter(heimdall, parseFilter(b.filter), b.kind, KIND_META.pods.columns)).toBe(true);
    expect(matchesFilter(running, parseFilter(b.filter), b.kind, KIND_META.pods.columns)).toBe(false);
    // A CrashLoopBackOff pod on the background cluster matches too.
    const odin = buildPodRows("odin-staging");
    const web = odin.find((r) => r.name === "web-6f9c7d5b4-abc12")!;
    expect(matchesFilter(web, parseFilter(b.filter), b.kind, KIND_META.pods.columns)).toBe(true);
  });

  it("Warnings matches Warning events, not Normal ones", () => {
    const b = BUILTIN_VIEWS.find((v) => v.id === "builtin-warnings")!;
    const evs = buildKindRows("events");
    const warn = evs.find((r) => r.cells[0]?.text === "Warning")!;
    const normal = evs.find((r) => r.cells[0]?.text === "Normal")!;
    expect(matchesFilter(warn, parseFilter(b.filter), b.kind, KIND_META.events.columns)).toBe(true);
    expect(matchesFilter(normal, parseFilter(b.filter), b.kind, KIND_META.events.columns)).toBe(false);
  });

  it("Pending workloads matches Pending pods, not Running ones", () => {
    const b = BUILTIN_VIEWS.find((v) => v.id === "builtin-pending")!;
    const rows = buildPodRows("freya");
    const pending = rows.find((r) => r.name === "valkyrie-api-canary-89f7c5d4b-nn2kp")!;
    const running = rows.find((r) => r.name === "valkyrie-api-7d9f8b64d-x2k4n")!;
    expect(matchesFilter(pending, parseFilter(b.filter), b.kind, KIND_META.pods.columns)).toBe(true);
    expect(matchesFilter(running, parseFilter(b.filter), b.kind, KIND_META.pods.columns)).toBe(false);
  });

  it("Recent failures matches a problem row whose SEVERITY cell is 'error'", () => {
    const b = BUILTIN_VIEWS.find((v) => v.id === "builtin-failures")!;
    const err: Row = {
      uid: "p1",
      name: "heimdall",
      cells: [
        { text: "error", tone: "err" },
        { text: "Pod", tone: "primary" },
        { text: "heimdall", tone: "secondary" },
        { text: "CrashLoopBackOff", tone: "secondary" },
      ],
    };
    const warn: Row = {
      uid: "p2",
      name: "canary",
      cells: [
        { text: "warning", tone: "warn" },
        { text: "Pod", tone: "primary" },
        { text: "canary", tone: "secondary" },
        { text: "Pending", tone: "secondary" },
      ],
    };
    expect(matchesFilter(err, parseFilter(b.filter), "problems", KIND_META.problems.columns)).toBe(true);
    expect(matchesFilter(warn, parseFilter(b.filter), "problems", KIND_META.problems.columns)).toBe(false);
  });
});
