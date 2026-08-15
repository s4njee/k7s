import { describe, expect, it } from "vitest";
import {
  actionsFor,
  actionVerbs,
  runBulk,
  bulkErrorText,
  confirmText,
  listNames,
  plural,
  type ActionId,
} from "./actions";
import type { Row } from "../providers/types";

function row(name: string, extra: Partial<Row> = {}): Row {
  return { uid: `uid-${name}`, name, namespace: "prod", cells: [], ...extra };
}

const ids = (kind: string, rows: Row[]): ActionId[] => actionsFor(kind, rows).map((a) => a.id);

describe("actionsFor — single row", () => {
  it("offers pod actions on a pod", () => {
    const got = ids("pods", [row("p")]);
    expect(got).toContain("delete");
    expect(got).toContain("restart");
    expect(got).toContain("forward");
    expect(got).not.toContain("scale");
    expect(got).not.toContain("cordon");
  });

  it("offers node actions on a node, but not delete", () => {
    const got = ids("nodes", [row("n")]);
    expect(got).toEqual(expect.arrayContaining(["cordon", "uncordon", "drain"]));
    // Deleting a Node object doesn't decommission a machine; it deregisters it,
    // which is not what a Delete item in a list view implies.
    expect(got).not.toContain("delete");
  });

  it("offers scale only on scalable workloads", () => {
    expect(ids("deployments", [row("d")])).toContain("scale");
    expect(ids("statefulsets", [row("s")])).toContain("scale");
    expect(ids("daemonsets", [row("ds")])).not.toContain("scale");
    expect(ids("pods", [row("p")])).not.toContain("scale");
  });

  /** A Helm row is a view over a storage Secret; deleting it corrupts the release. */
  it("offers nothing destructive on a Helm release", () => {
    expect(ids("helm", [row("rel")])).not.toContain("delete");
  });

  /** B81: the release's own verbs — uninstall is the delete replacement, rollback
   *  lives on the History panel rather than the menu. */
  it("offers uninstall (and only uninstall) on a Helm release", () => {
    const got = ids("helm", [row("rel")]);
    expect(got).toContain("uninstall");
    expect(got).not.toContain("delete");
    expect(got).not.toContain("scale");
  });

  it("never offers uninstall on non-Helm kinds", () => {
    expect(ids("pods", [row("p")])).not.toContain("uninstall");
    expect(ids("deployments", [row("d")])).not.toContain("uninstall");
  });

  it("offers View pods only when there is a selector to filter by", () => {
    expect(ids("deployments", [row("d", { selector: { app: "x" } })])).toContain("view-pods");
    expect(ids("deployments", [row("d")])).not.toContain("view-pods");
    expect(ids("deployments", [row("d", { selector: {} })])).not.toContain("view-pods");
  });

  it("offers only Bookmark on a kind with no verbs (B56)", () => {
    // Namespaces have no workload verbs, so bookmarking is the whole menu.
    expect(actionsFor("namespaces", [row("ns")]).map((a) => a.id)).toEqual(["bookmark"]);
  });

  it("offers Bookmark on any navigable object, and never on the events feed (B56)", () => {
    expect(ids("pods", [row("p")])).toContain("bookmark");
    expect(ids("namespaces", [row("ns")])).toContain("bookmark");
    expect(ids("events", [row("e")])).not.toContain("bookmark");
  });

  // ---- batch verbs (B47) ----
  it("offers Suspend on a running CronJob, Resume on a suspended one", () => {
    const running = row("report-gen", { cron: { suspended: false } });
    const suspended = row("cache-warm", { cron: { suspended: true } });
    expect(ids("cronjobs", [running])).toContain("suspend");
    expect(ids("cronjobs", [running])).not.toContain("resume");
    expect(ids("cronjobs", [suspended])).toContain("resume");
    expect(ids("cronjobs", [suspended])).not.toContain("suspend");
  });

  it("offers Run now on a CronJob regardless of suspend state", () => {
    expect(ids("cronjobs", [row("report-gen", { cron: { suspended: true } })])).toContain("run-now");
    expect(ids("cronjobs", [row("report-gen", { cron: { suspended: false } })])).toContain("run-now");
  });

  it("offers Retry only on a failed Job", () => {
    expect(ids("jobs", [row("migrate", { job: { failed: true } })])).toContain("retry");
    expect(ids("jobs", [row("migrate", { job: { failed: false } })])).not.toContain("retry");
    // A job that merely hasn't finished has no failed condition to retry.
    expect(ids("jobs", [row("migrate", {})])).not.toContain("retry");
  });

  it("offers the batch verbs nowhere else", () => {
    for (const kind of ["deployments", "pods", "services", "nodes"]) {
      const got = ids(kind, [row("x")]);
      expect(got, kind).not.toContain("suspend");
      expect(got, kind).not.toContain("run-now");
      expect(got, kind).not.toContain("retry");
    }
  });

  it("offers nothing for an empty selection", () => {
    expect(actionsFor("pods", [])).toEqual([]);
  });
});

describe("actionsFor — bulk", () => {
  const pods = [row("a"), row("b"), row("c")];

  it("keeps bulk-capable actions", () => {
    const got = ids("pods", pods);
    expect(got).toContain("delete");
    expect(got).toContain("restart");
  });

  /**
   * Both take a parameter that would have to be the same for every row, which is
   * never what someone selecting three different pods means.
   */
  it("drops actions that need a parameter", () => {
    const got = ids("pods", pods);
    expect(got).not.toContain("forward");
    expect(ids("deployments", [row("d1"), row("d2")])).not.toContain("scale");
  });

  /**
   * Draining several nodes at once is how you evict everything with nowhere left
   * to reschedule it — and the progress UI tracks one node at a time regardless.
   */
  it("drops drain, but keeps cordon", () => {
    const nodes = [row("n1"), row("n2")];
    expect(ids("nodes", nodes)).not.toContain("drain");
    expect(ids("nodes", nodes)).toContain("cordon");
  });

  /**
   * An action must apply to every row, not just one — otherwise the menu offers
   * something that fails partway through and leaves the selection half-acted-on.
   */
  it("requires the action to apply to every row", () => {
    const mixed = [row("d1", { selector: { app: "x" } }), row("d2")];
    expect(ids("deployments", mixed)).not.toContain("view-pods");
  });
});

describe("confirmText", () => {
  it("names the single object", () => {
    expect(confirmText("delete", "pods", [row("api-7d9f")])).toBe("Delete api-7d9f?");
  });

  /**
   * The whole risk of a bulk action is that the selection isn't what you think.
   * A count alone can't reveal that; the names can.
   */
  it("enumerates the names for a bulk action", () => {
    const text = confirmText("delete", "pods", [row("a"), row("b"), row("c")]);
    expect(text).toContain("3 pods");
    expect(text).toContain("a, b, c");
  });

  it("truncates a long list instead of printing hundreds of names", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`pod-${i}`));
    const text = confirmText("delete", "pods", rows);
    expect(text).toContain("30 pods");
    expect(text).toContain("and 22 more");
    expect(text).not.toContain("pod-25");
  });

  /** Pod restart is delete-and-recreate; a rollout is a template patch. */
  it("explains the mechanism, which differs by kind", () => {
    expect(confirmText("restart", "pods", [row("p")])).toContain("controller recreates it");
    expect(confirmText("restart", "deployments", [row("d")])).toContain("rollout restart");
  });

  it("uses plural grammar for a bulk pod restart", () => {
    const text = confirmText("restart", "pods", [row("a"), row("b")]);
    expect(text).toContain("their controllers recreate them");
  });
});

describe("plural", () => {
  it("singularises and pluralises known kinds", () => {
    expect(plural("pods", 1)).toBe("pod");
    expect(plural("pods", 3)).toBe("pods");
    expect(plural("nodes", 2)).toBe("nodes");
  });

  /** "ingresss" would be visibly wrong in a confirmation. */
  it("handles sibilant endings", () => {
    expect(plural("ingresses", 2)).toBe("ingresses");
    // B81: a Helm release uninstalls; singular reads "release".
    expect(plural("helm", 1)).toBe("release");
    expect(plural("helm", 2)).toBe("releases");
  });

  /** Custom kinds are "group/plural" ids; the readable half is after the slash. */
  it("falls back to the plural half of a custom kind id", () => {
    expect(plural("argoproj.io/applications", 1)).toBe("applications");
  });
});

describe("listNames", () => {
  it("joins a short list in full", () => {
    expect(listNames([row("a"), row("b")])).toBe("a, b");
  });
});

describe("bulkErrorText", () => {
  it("is silent when everything worked", () => {
    expect(bulkErrorText({ ok: 3, failures: [] })).toBeNull();
  });

  /**
   * A partial failure is the normal outcome across objects with different owners
   * or permissions, and "some worked" is exactly what the user has to know before
   * deciding what to retry.
   */
  it("reports a partial failure with counts and reasons", () => {
    const text = bulkErrorText({ ok: 2, failures: [{ name: "b", error: "forbidden" }] });
    expect(text).toContain("2 succeeded");
    expect(text).toContain("1 failed");
    expect(text).toContain("b: forbidden");
  });

  it("says so when nothing worked", () => {
    const text = bulkErrorText({
      ok: 0,
      failures: [
        { name: "a", error: "forbidden" },
        { name: "b", error: "forbidden" },
      ],
    });
    expect(text).toContain("all 2 failed");
  });
});

describe("runBulk", () => {
  /**
   * The B39 acceptance criterion: N selected rows issues N calls, each with its
   * own object — not one call, and not a call with only the first row.
   */
  it("calls the operation once per row", async () => {
    const seen: string[] = [];
    const out = await runBulk([row("a"), row("b"), row("c")], async (r) => {
      seen.push(r.name);
    });
    expect(seen.sort()).toEqual(["a", "b", "c"]);
    expect(out).toEqual({ ok: 3, failures: [] });
  });

  /**
   * One object failing must not abandon the rest half-done — a selection often
   * spans objects with different owners or permissions.
   */
  it("completes the others when one fails, and names the one that did", async () => {
    const out = await runBulk([row("a"), row("b"), row("c")], async (r) => {
      if (r.name === "b") throw new Error("forbidden");
    });
    expect(out.ok).toBe(2);
    expect(out.failures).toEqual([{ name: "b", error: "forbidden" }]);
  });

  it("survives a rejection that isn't an Error", async () => {
    const out = await runBulk([row("a")], async () => {
      throw "plain string"; // eslint-disable-line @typescript-eslint/no-throw-literal
    });
    expect(out.failures[0].error).toBe("plain string");
  });

  it("does nothing for an empty selection", async () => {
    expect(await runBulk([], async () => {})).toEqual({ ok: 0, failures: [] });
  });
});

describe("actionVerbs (B88 SSAR map)", () => {
  const pod = { uid: "p", name: "web-abc", namespace: "prod", cells: [] } as unknown as Row;
  const dep = { uid: "d", name: "web", namespace: "prod", cells: [] } as unknown as Row;

  it("maps each action to the backend's actual verb + resource", () => {
    expect(actionVerbs("scale", "deployments", dep)).toEqual([{ verb: "patch", resource: "deployments", namespace: "prod" }]);
    expect(actionVerbs("delete", "pods", pod)).toEqual([{ verb: "delete", resource: "pods", namespace: "prod" }]);
    expect(actionVerbs("cordon", "nodes", { ...dep, namespace: undefined })).toEqual([
      { verb: "patch", resource: "nodes", namespace: undefined },
    ]);
  });

  it("restart is a pod delete or a rollout patch, matching how each executes", () => {
    expect(actionVerbs("restart", "pods", pod)).toEqual([{ verb: "delete", resource: "pods", namespace: "prod" }]);
    expect(actionVerbs("restart", "deployments", dep)).toEqual([{ verb: "patch", resource: "deployments", namespace: "prod" }]);
  });

  it("drain needs both the node cordon and the eviction verb", () => {
    const verbs = actionVerbs("drain", "nodes", { ...dep, namespace: undefined });
    expect(verbs).toContainEqual({ verb: "patch", resource: "nodes", namespace: undefined });
    expect(verbs).toContainEqual({ verb: "create", resource: "pods/eviction", namespace: undefined });
  });

  it("uses the CRD plural for custom kinds", () => {
    expect(actionVerbs("delete", "argoproj.io/applications", { ...dep, namespace: undefined })).toEqual([
      { verb: "delete", resource: "applications", namespace: undefined },
    ]);
  });
});
