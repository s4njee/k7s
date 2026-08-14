/**
 * Problems view (B32): a frontend-only aggregation over the rows the store
 * already holds — no new watchers. Each source is a pure scan of one kind's
 * rows, producing a navigable problem row (SEVERITY, KIND, OBJECT, REASON, AGE)
 * that jumps to the object it's about.
 *
 * Everything here is derived from display data (tones + status text) plus the
 * job-failure flag the backend attaches — the same information the tables show,
 * so the problems view can never disagree with what's on screen.
 */

import type { Cell, InvolvedRef, Row } from "../providers/types";

/** A pod must be this old before Pending stops being "normal scheduling". */
const PENDING_MS = 5 * 60 * 1000;
/** A pod must be this old before Terminating means "stuck". */
const TERMINATING_MS = 60 * 1000;
/** Warning events are capped so a noisy namespace can't flood the view. */
const EVENT_CAP = 8;

// Cell indices into the backend's row layouts (see src-tauri mappers).
const NODE_STATUS = 1;
const POD_AGE = 6;
const POD_STATUS = 7;
const DEPLOY_READY = 2;
const STS_READY = 2;
const DS_READY = 3;
const EVENT_TYPE = 0;
const EVENT_REASON = 1;
const EVENT_OBJECT = 2;
const EVENT_MESSAGE = 6;

/**
 * Derive the problems view from the store's rows, worst first (red before
 * amber, then newest). Empty for a healthy cluster. `now` is injectable so the
 * age thresholds are testable against a fixed clock.
 */
export function deriveProblems(rows: Record<string, Row[]>, now: number = Date.now()): Row[] {
  const out: Row[] = [];

  // ---- Nodes: NotReady (err). Nodes carry no age cell, so the AGE renders "—".
  for (const r of rows.nodes ?? []) {
    if (r.cells[NODE_STATUS]?.tone === "err") {
      out.push(problem(r, "err", "Node", r.name, "NotReady", involved("Node", undefined, r.name), undefined));
    }
  }

  // ---- Pods: err tone, or Pending/Terminating past its threshold ----
  for (const r of rows.pods ?? []) {
    const status = r.cells[POD_STATUS];
    if (!status) continue;
    const age = ageMs(r.cells[POD_AGE], now);
    if (status.tone === "err") {
      out.push(problem(r, "err", "Pod", r.name, status.text, involved("Pod", r.namespace, r.name), r.cells[POD_AGE]));
    } else if (status.text === "Pending" && age > PENDING_MS) {
      out.push(
        problem(r, "warn", "Pod", r.name, `Pending for ${fmtAge(age)}`, involved("Pod", r.namespace, r.name), r.cells[POD_AGE]),
      );
    } else if (status.text === "Terminating" && age > TERMINATING_MS) {
      out.push(
        problem(
          r,
          "warn",
          "Pod",
          r.name,
          `stuck Terminating for ${fmtAge(age)}`,
          involved("Pod", r.namespace, r.name),
          r.cells[POD_AGE],
        ),
      );
    }
  }

  // ---- Workloads: ready < desired ----
  for (const r of rows.deployments ?? []) {
    const ready = r.cells[DEPLOY_READY];
    if (ready?.tone === "warn") {
      out.push(problem(r, "warn", "Deployment", r.name, `${ready.text} ready`, involved("Deployment", r.namespace, r.name), lastCell(r)));
    }
  }
  for (const r of rows.statefulsets ?? []) {
    const ready = r.cells[STS_READY];
    if (ready?.tone === "warn") {
      out.push(problem(r, "warn", "StatefulSet", r.name, `${ready.text} ready`, involved("StatefulSet", r.namespace, r.name), lastCell(r)));
    }
  }
  for (const r of rows.daemonsets ?? []) {
    const ready = r.cells[DS_READY];
    if (ready?.tone === "warn") {
      out.push(problem(r, "warn", "DaemonSet", r.name, `${ready.text} ready`, involved("DaemonSet", r.namespace, r.name), lastCell(r)));
    }
  }

  // ---- Jobs: failed (the COMPLETIONS cell can't distinguish running from
  //      failed, so this keys on the backend's status-derived flag) ----
  for (const r of rows.jobs ?? []) {
    if (r.job?.failed) {
      out.push(problem(r, "err", "Job", r.name, "job failed", involved("Job", r.namespace, r.name), lastCell(r)));
    }
  }

  // ---- Warning events (capped): one problem per event row, navigable to the
  //      object the event is about ----
  let events = 0;
  for (const r of rows.events ?? []) {
    if (events >= EVENT_CAP) break;
    if (r.cells[EVENT_TYPE]?.text !== "Warning") continue;
    events++;
    const reason = r.cells[EVENT_REASON]?.text ?? "";
    const message = r.cells[EVENT_MESSAGE]?.text ?? "";
    const object = r.cells[EVENT_OBJECT]?.text ?? r.name;
    out.push(problem(r, "warn", "Event", object, short(message || reason), r.involved, lastCell(r)));
  }

  // Red before amber, then newest first.
  out.sort((a, b) => severity(a) - severity(b) || ageMs(b.cells[4], now) - ageMs(a.cells[4], now));
  return out;
}

/** 0 for err (red), 1 for warn (amber) — the SEVERITY cell's tone. */
function severity(r: Row): number {
  return r.cells[0]?.tone === "err" ? 0 : 1;
}

/** Build one problem row: SEVERITY, KIND, OBJECT, REASON, AGE + a jump target. */
function problem(
  source: Row,
  sev: "err" | "warn",
  kind: string,
  object: string,
  reason: string,
  target: InvolvedRef | undefined,
  age: Cell | undefined,
): Row {
  return {
    // Keyed on the source's stable uid, so a problem that persists across
    // updates keeps its React identity.
    uid: `problem:${source.uid}`,
    name: object,
    namespace: source.namespace,
    cells: [
      { text: sev === "err" ? "error" : "warning", tone: sev },
      { text: kind, tone: "primary" },
      { text: object, tone: "secondary" },
      { text: reason, tone: "secondary" },
      age ?? { text: "—", tone: "muted" },
    ],
    involved: target,
  };
}

/** The source's AGE cell (its last cell) carried so the table formats it live. */
function lastCell(source: Row): Cell | undefined {
  return source.cells[source.cells.length - 1];
}

/** A nav target for a built-in kind; namespace undefined for cluster-scoped. */
function involved(kind: string, namespace: string | undefined, name: string): InvolvedRef {
  return { kind, name, namespace };
}

/** "2h14m" → milliseconds; NaN when the string isn't a k8s-style age. */
function humanAgeMs(text: string): number {
  const parts = text.match(/(\d+)([smhd])/g);
  if (!parts) return NaN;
  let ms = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    const unit = p[p.length - 1];
    ms += n * (unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5);
  }
  return ms;
}

/** Milliseconds since now from an AGE cell: an RFC3339 timestamp (real mode)
 *  or a humanized literal (demo mode). NaN when unknowable — a threshold then
 *  never trips, so we never flag a problem on an unknown age. */
function ageMs(cell: Cell | undefined, now: number): number {
  if (!cell || !cell.text) return NaN;
  if (cell.format === "age") {
    const t = Date.parse(cell.text);
    return Number.isNaN(t) ? NaN : Math.max(0, now - t);
  }
  return humanAgeMs(cell.text);
}

/** "12m", "2h14m", "1h" — for the reason text. */
function fmtAge(ms: number): string {
  const m = Math.floor(ms / 6e4);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
}

/** Truncate a message to one line's worth, keeping the full thing in a title. */
function short(text: string): string {
  const t = text.trim();
  return t.length > 64 ? `${t.slice(0, 61)}…` : t || "warning";
}
