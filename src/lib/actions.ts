/**
 * The object-action model (B39) — what can be done to a resource, as data.
 *
 * This exists because the same actions are now reachable from two places: the
 * detail panel's "…" menu and the table's row context menu. Those had to agree
 * about *everything* — which kinds can be deleted, which need a confirmation,
 * what the confirmation says — and two copies of that would drift into a menu
 * offering an action the other refuses.
 *
 * Data, not closures, following lib/palette.ts: the predicates and the
 * confirmation wording are the part worth testing, and they stay testable
 * without a provider, a store, or a DOM. Execution lives with the components
 * (see runAction), because it needs the provider and the store.
 *
 * The one concept the old single-row menu didn't have is `bulk`. An action that
 * takes a parameter (scale, forward) or streams progress for one object at a
 * time (drain) cannot sensibly apply to a selection, so a multi-row menu must
 * hide it rather than silently act on only the first row.
 */

import type { KindId, Row } from "../providers/types";

export type ActionId =
  | "view-pods"
  | "forward"
  | "scale"
  | "restart"
  | "cordon"
  | "uncordon"
  | "drain"
  | "delete";

export interface ActionDef {
  id: ActionId;
  /** Menu label. A trailing "…" means another step follows, as in the rest of the app. */
  label: string;
  /** Rendered in the danger colour, and grouped at the bottom. */
  danger?: boolean;
  /**
   * "immediate" runs on click; "confirm" needs a yes; "form" collects a
   * parameter first. Only "form" actions have bespoke UI.
   */
  mode: "immediate" | "confirm" | "form";
  /** Whether this can act on a whole selection at once. */
  bulk: boolean;
}

/** Every action, in menu order. Order is display order: safe things first. */
const ALL: ActionDef[] = [
  { id: "view-pods", label: "View pods", mode: "immediate", bulk: false },
  { id: "forward", label: "Forward…", mode: "form", bulk: false },
  { id: "scale", label: "Scale…", mode: "form", bulk: false },
  { id: "restart", label: "Restart…", mode: "confirm", bulk: true },
  { id: "cordon", label: "Cordon", mode: "immediate", bulk: true },
  { id: "uncordon", label: "Uncordon", mode: "immediate", bulk: true },
  // Not bulk: a drain streams progress for one node and can take minutes, and
  // draining several nodes at once is how you accidentally evict everything with
  // nowhere left to reschedule it.
  { id: "drain", label: "Drain…", danger: true, mode: "confirm", bulk: false },
  { id: "delete", label: "Delete…", danger: true, mode: "confirm", bulk: true },
];

/** Does this action apply to a single row of this kind? */
function applies(id: ActionId, kind: KindId, row: Row): boolean {
  switch (id) {
    case "delete":
      // Nodes and namespaces are deleted through their own lifecycle, and a Helm
      // release "row" is a synthetic view over a storage Secret — deleting that
      // corrupts the release rather than uninstalling it.
      return kind !== "nodes" && kind !== "namespaces" && kind !== "helm";
    case "scale":
      return kind === "deployments" || kind === "statefulsets";
    case "cordon":
    case "uncordon":
    case "drain":
      return kind === "nodes";
    case "restart":
      return isRestartable(kind);
    case "view-pods":
      // Needs a selector to build the filter from; a workload without one would
      // navigate to an empty table.
      return isRolloutKind(kind) && !!row.selector && Object.keys(row.selector).length > 0;
    case "forward":
      return kind === "pods" || kind === "services";
  }
}

/** Kinds whose restart is a `kubectl rollout restart` template patch. */
export function isRolloutKind(kind: KindId): boolean {
  return kind === "deployments" || kind === "statefulsets" || kind === "daemonsets";
}

/** Anything that can be restarted at all — a pod, or a rollout-capable workload. */
export function isRestartable(kind: KindId): boolean {
  return kind === "pods" || isRolloutKind(kind);
}

/**
 * The actions available for `rows` of `kind`.
 *
 * With more than one row, only bulk-capable actions survive — and an action must
 * apply to *every* row, not merely one of them, so a menu can never offer
 * something that would fail partway through the selection.
 */
export function actionsFor(kind: KindId, rows: Row[]): ActionDef[] {
  if (rows.length === 0) return [];
  const bulk = rows.length > 1;
  return ALL.filter((a) => {
    if (bulk && !a.bulk) return false;
    return rows.every((row) => applies(a.id, kind, row));
  });
}

/** Names, truncated — a confirmation listing 200 pods is not a confirmation. */
const MAX_LISTED = 8;

export function listNames(rows: Row[]): string {
  const names = rows.map((r) => r.name);
  if (names.length <= MAX_LISTED) return names.join(", ");
  const rest = names.length - MAX_LISTED;
  return `${names.slice(0, MAX_LISTED).join(", ")} and ${rest} more`;
}

/**
 * What the confirmation says.
 *
 * It always enumerates what is about to happen — the count *and* the names.
 * "Delete 3 pods?" is not enough to act on safely: the whole risk of bulk
 * actions is that the selection isn't what you think it is, and the names are
 * the only thing that reveals that.
 */
export function confirmText(id: ActionId, kind: KindId, rows: Row[]): string {
  const n = rows.length;
  const what = n === 1 ? rows[0].name : `${n} ${plural(kind, n)}`;
  const names = n === 1 ? "" : ` (${listNames(rows)})`;

  switch (id) {
    case "delete":
      return `Delete ${what}?${names}`;
    case "restart":
      return kind === "pods"
        ? `Restart ${what}?${names} Deletes the ${n === 1 ? "pod" : "pods"}; ${
            n === 1 ? "its controller recreates it" : "their controllers recreate them"
          }.`
        : `Restart ${what}?${names} Rolls every pod (kubectl rollout restart).`;
    case "drain":
      return `Drain ${what}? This cordons it and evicts every pod on it (DaemonSet and static pods stay).`;
    case "cordon":
      return `Cordon ${what}?${names}`;
    case "uncordon":
      return `Uncordon ${what}?${names}`;
    default:
      return `${id} ${what}?${names}`;
  }
}

/** A readable noun for a kind, singular or plural. */
export function plural(kind: KindId, n: number): string {
  const singular: Record<string, string> = {
    pods: "pod",
    deployments: "deployment",
    replicasets: "replicaset",
    statefulsets: "statefulset",
    daemonsets: "daemonset",
    jobs: "job",
    cronjobs: "cronjob",
    services: "service",
    nodes: "node",
    configmaps: "configmap",
    secrets: "secret",
    ingresses: "ingress",
  };
  // Custom kinds are "group/plural" ids; the plural half is the readable part.
  const base = singular[kind] ?? kind.split("/").pop() ?? String(kind);
  if (n === 1) return base;
  // "ingress" → "ingresses", everything else takes a plain -s. The map above is
  // already plural-derived, so this only has to handle the sibilant case.
  return /(s|x|z|ch|sh)$/.test(base) ? `${base}es` : `${base}s`;
}

/**
 * How a bulk run went. Reported rather than swallowed: a partial failure is the
 * normal outcome when a selection spans objects with different owners or
 * permissions, and "some of them worked" is exactly what the user needs to know.
 */
export interface BulkOutcome {
  ok: number;
  failures: { name: string; error: string }[];
}

/**
 * Run `fn` once per row, collecting per-object outcomes.
 *
 * Concurrent and `allSettled` rather than `all`: one object failing — a different
 * owner, a stricter RBAC rule, something already gone — must not abandon the rest
 * half-done, and the user needs to know exactly which ones failed rather than
 * just that "it" errored.
 *
 * Lives here rather than in the component so "N selected rows issues N calls"
 * is provable without a DOM.
 */
export async function runBulk<T extends { name: string }>(
  rows: T[],
  fn: (row: T) => Promise<void>,
): Promise<BulkOutcome> {
  const results = await Promise.allSettled(rows.map(fn));
  const failures: BulkOutcome["failures"] = [];
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok += 1;
    else {
      const reason: unknown = r.reason;
      failures.push({
        name: rows[i].name,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });
  return { ok, failures };
}

/** Turn a bulk outcome into the sentence shown in the error banner, or null. */
export function bulkErrorText(outcome: BulkOutcome): string | null {
  if (outcome.failures.length === 0) return null;
  const list = outcome.failures.map((f) => `${f.name}: ${f.error}`).join("; ");
  if (outcome.ok === 0) return `all ${outcome.failures.length} failed — ${list}`;
  return `${outcome.ok} succeeded, ${outcome.failures.length} failed — ${list}`;
}
