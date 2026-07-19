/**
 * Building the command palette's results (B28).
 *
 * Pure: it turns a query plus a snapshot of the store into a ranked list, so the
 * ranking can be tested without a DOM. The component decides what an item *does*;
 * this decides what exists and in what order.
 *
 * Everything here reads rows the store already has. The palette never fetches:
 * objects of a CRD kind whose watcher isn't running simply aren't in the list,
 * which is honest — we don't know them — and jumping to the kind starts its
 * watcher exactly as clicking the sidebar does.
 */

import { fuzzyMatch } from "./fuzzy";
import { isCustomKind, KIND_META, KIND_ORDER, type KindId } from "./kinds";
import type { CustomKind, Row } from "../providers/types";

/** Actions the palette can run. Data, not closures, so this stays testable. */
export type ActionId = "settings" | "import-kubeconfig" | "cordon" | "uncordon";

interface Scored {
  /** Ranking score; only comparable within one query. */
  score: number;
  /** Matched positions within `label`, for highlighting. May be empty. */
  indices: number[];
}

/** Navigate to a resource kind. */
export interface KindItem extends Scored {
  type: "kind";
  id: KindId;
  label: string;
  icon: string;
  /** Right-hand context, e.g. the nav group or the CRD's API group. */
  hint: string;
}

/** Navigate to a specific object and select it. */
export interface ObjectItem extends Scored {
  type: "object";
  kind: KindId;
  row: Row;
  label: string;
  hint: string;
}

/** Run an app command. */
export interface ActionItem extends Scored {
  type: "action";
  id: ActionId;
  label: string;
  hint: string;
}

export type PaletteItem = KindItem | ObjectItem | ActionItem;

/** The slice of the store the palette reads. */
export interface PaletteContext {
  rows: Record<string, Row[]>;
  customKinds: CustomKind[];
  /** The current kind, which decides which object actions apply. */
  nav: KindId;
  selectedRow: Row | null;
}

/** A query split into its `ns:` scope and the text to match. */
export interface ParsedQuery {
  /** Namespace to restrict object results to, if the query named one. */
  namespace?: string;
  text: string;
}

/**
 * Kinds whose objects are not worth searching.
 *
 * Events are excluded because an event's name is an opaque id
 * ("wiki-6b6d775f4-djpwx.17c3f8a2b1"), so it matches nothing a human would type
 * and would only crowd the list. The Events *view* is still reachable by name.
 */
const UNSEARCHABLE_KINDS: ReadonlySet<string> = new Set(["events"]);

/**
 * Per-class caps. The palette is a keyboard tool: past a screenful, more results
 * are noise, and the answer is a better query rather than more scrolling.
 */
const MAX_KINDS = 8;
const MAX_OBJECTS = 25;
const MAX_ACTIONS = 6;

/**
 * Split a leading `ns:<name>` scope off a query.
 *
 * `ns:prod wiki` → search "wiki" within prod. The scope is only recognised at
 * the start: a bare "ns:" mid-query is far more likely to be someone typing a
 * name than reaching for a filter.
 */
export function parseQuery(raw: string): ParsedQuery {
  const m = /^ns:(\S*)\s*(.*)$/s.exec(raw.trimStart());
  if (!m) return { text: raw.trim() };
  const [, namespace, text] = m;
  // "ns:" alone scopes to nothing yet — treat it as no scope so results don't
  // vanish mid-keystroke.
  return namespace === "" ? { text: text.trim() } : { namespace, text: text.trim() };
}

/** Build the ranked result list for a query. */
export function buildPalette(raw: string, ctx: PaletteContext): PaletteItem[] {
  const { namespace, text } = parseQuery(raw);

  const kinds = rankClass(kindCandidates(ctx), text, MAX_KINDS);
  const actions = rankClass(actionCandidates(ctx), text, MAX_ACTIONS);
  // Objects are only listed once there's something to match: every row in the
  // cluster is not a useful default screen, and the empty palette should show
  // where you can *go*, not everything that exists.
  const objects = text === "" ? [] : rankClass(objectCandidates(ctx, namespace), text, MAX_OBJECTS);

  // One list, ranked together: the scores come from the same query, so they're
  // comparable, and a strong object match should be able to outrank a weak kind
  // match rather than being stuck below it.
  return [...kinds, ...actions, ...objects].sort(byScore);
}

/** Best-first, with a stable tiebreak so equal scores don't shuffle per render. */
function byScore(a: PaletteItem, b: PaletteItem): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.label.localeCompare(b.label);
}

/**
 * Score one class of candidates and keep the best `max`.
 *
 * Each candidate offers one or more strings to match against (a kind matches on
 * its label *or* its id); the best-scoring one wins, and highlighting only
 * applies when the *label* was what matched — highlighting positions from a
 * string the user can't see would be nonsense.
 */
function rankClass<T extends PaletteItem>(
  candidates: { item: Omit<T, "score" | "indices">; targets: string[] }[],
  text: string,
  max: number,
): T[] {
  const out: T[] = [];
  for (const { item, targets } of candidates) {
    let best: { score: number; indices: number[] } | null = null;
    for (let i = 0; i < targets.length; i++) {
      const m = fuzzyMatch(text, targets[i]);
      if (!m) continue;
      // Indices are only meaningful against the label, which is targets[0].
      const indices = i === 0 ? m.indices : [];
      if (!best || m.score > best.score) best = { score: m.score, indices };
    }
    if (best) out.push({ ...item, score: best.score, indices: best.indices } as T);
  }
  return out.sort(byScore).slice(0, max);
}

/** Every kind that can be navigated to: the built-ins plus discovered CRDs. */
function kindCandidates(ctx: PaletteContext) {
  const items: { item: Omit<KindItem, "score" | "indices">; targets: string[] }[] = [];

  for (const id of KIND_ORDER) {
    const meta = KIND_META[id];
    items.push({
      item: { type: "kind", id, label: meta.label, icon: meta.icon, hint: meta.group },
      // The id is matched too, so "pods" finds "Pods" and — more importantly —
      // a plural finds a singular Kind name.
      targets: [meta.label, id],
    });
  }

  for (const ck of ctx.customKinds) {
    items.push({
      item: { type: "kind", id: ck.id, label: ck.kind, icon: "◈", hint: ck.group },
      // "applications" can't match the label "Application" (it's longer), so the
      // id — "argoproj.io/applications" — is what makes the plural work.
      targets: [ck.kind, ck.id],
    });
  }

  return items;
}

/** Objects from rows already in the store. */
function objectCandidates(ctx: PaletteContext, namespace: string | undefined) {
  const items: { item: Omit<ObjectItem, "score" | "indices">; targets: string[] }[] = [];

  for (const [kind, rows] of Object.entries(ctx.rows)) {
    if (UNSEARCHABLE_KINDS.has(kind)) continue;
    const label = kindLabelFor(kind, ctx.customKinds);

    for (const row of rows) {
      if (namespace && row.namespace !== namespace) continue;
      items.push({
        item: {
          type: "object",
          kind,
          row,
          label: row.name,
          hint: row.namespace ? `${label} · ${row.namespace}` : label,
        },
        // "argocd/wiki" should find it too, so the qualified name is a fallback
        // target — it only wins when the bare name doesn't match.
        targets: row.namespace ? [row.name, `${row.namespace}/${row.name}`] : [row.name],
      });
    }
  }

  return items;
}

/**
 * App commands, plus the object actions that are safe to fire from a palette.
 *
 * Deliberately *not* here: delete, drain, scale, forward. Each needs a
 * confirmation or a parameter, and that UI lives in the detail panel's actions
 * menu — a palette where Enter can delete a pod is a footgun, not a shortcut.
 * Cordon/uncordon qualify because they take no argument and are trivially
 * reversible by each other.
 */
function actionCandidates(ctx: PaletteContext) {
  const items: { item: Omit<ActionItem, "score" | "indices">; targets: string[] }[] = [
    {
      item: { type: "action", id: "settings", label: "Open settings", hint: "app" },
      targets: ["Open settings", "preferences"],
    },
    {
      item: { type: "action", id: "import-kubeconfig", label: "Import kubeconfig…", hint: "app" },
      targets: ["Import kubeconfig"],
    },
  ];

  // Node actions need a selected node to act on.
  if (ctx.nav === "nodes" && ctx.selectedRow) {
    const node = ctx.selectedRow.name;
    items.push(
      {
        item: { type: "action", id: "cordon", label: `Cordon ${node}`, hint: "node" },
        targets: [`Cordon ${node}`],
      },
      {
        item: { type: "action", id: "uncordon", label: `Uncordon ${node}`, hint: "node" },
        targets: [`Uncordon ${node}`],
      },
    );
  }

  return items;
}

/** Display label for a kind id, resolving discovered CRDs. */
function kindLabelFor(kind: string, customKinds: CustomKind[]): string {
  if (!isCustomKind(kind)) return KIND_META[kind as keyof typeof KIND_META]?.label ?? kind;
  return customKinds.find((c) => c.id === kind)?.kind ?? kind;
}
