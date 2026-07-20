/**
 * Detail panel (Design §4). Opens for the selected row. Pods get a header with
 * status/node/age and the full tab strip; other kinds get a simpler header, and
 * their tabs depend on the kind — Logs/Shell need a container, and Properties
 * needs a gatherer (B18). The selected row's kind is the current nav kind, since
 * selection is cleared whenever nav changes.
 *
 * The header also carries transient state for the selected object: action errors,
 * and node drain progress (B20).
 */

import { useState } from "react";
import styles from "./DetailPanel.module.css";
import { useStore } from "../../store";
import { useNow } from "../../hooks/useNow";
import { formatAge } from "../../lib/format";
import { toneColor } from "../../lib/tone";
import { DETAIL_TABS, kindMeta, KINDS_WITH_PROPERTIES, tabsFor } from "../../lib/kinds";
import { drainErrors, drainSummary, drainTone, pdbBlocked } from "../../lib/drain";
import { LogsTab } from "./LogsTab";
import { PropertiesTab } from "./PropertiesTab";
import { MetricsTab } from "./MetricsTab";
import { ShellTab } from "./ShellTab";
import { NodeShellTab } from "./NodeShellTab";
import { YamlTab } from "./YamlTab";
import { EventsTab } from "./EventsTab";
import { ActionsMenu } from "./ActionsMenu";
import type { DrainProgress } from "../../providers/types";

export function DetailPanel() {
  const row = useStore((s) => s.selectedRow);
  const nav = useStore((s) => s.nav);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeDetail = useStore((s) => s.closeDetail);
  const customKinds = useStore((s) => s.customKinds);
  const drains = useStore((s) => s.drains);
  const now = useNow();

  // Error from an action (delete/scale/cordon), shown as a header banner.
  const [actionError, setActionError] = useState<string | null>(null);

  // Panel is closed when nothing is selected.
  if (!row) return null;

  // Drain progress for this node, if one has run this session (B20).
  const drain = nav === "nodes" ? drains[row.name] : undefined;

  const meta = row.pod; // present only for pods
  const isPod = !!meta;
  // Which tabs this kind gets — shared with the `[`/`]` cycle keys, so the strip
  // and the keyboard can't disagree about what exists (see lib/kinds.ts).
  const tabIds = tabsFor(nav, isPod);
  const tabs = DETAIL_TABS.filter((t) => tabIds.includes(t.id));
  const statusColor = meta ? toneColor(meta.statusTone) : "var(--text-muted)";
  // Custom kinds resolve their label from discovery, so this is a runtime lookup.
  const kindLabel = kindMeta(nav, customKinds)?.label ?? nav;

  // data-surface="panel": in light mode the inspector is dark chrome (tokens.css).
  return (
    <div className={styles.panel} data-surface="panel">
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.statusDot} style={{ background: statusColor }} />
          <div className={styles.name} title={row.name}>
            {row.name}
          </div>
          <ActionsMenu kind={nav} row={row} onError={setActionError} onDeleted={closeDetail} />
          <div className={styles.close} onClick={closeDetail} title="close">
            ×
          </div>
        </div>

        {actionError && (
          <div className={styles.actionError} onClick={() => setActionError(null)}>
            {actionError}
          </div>
        )}

        {/* Drain progress for this node (B20) — a drain runs for minutes, so it
            reports here rather than blocking the action menu. */}
        {drain && <DrainBanner progress={drain} />}

        {isPod ? (
          <div className={styles.meta}>
            <span>
              ns: <span className={styles.metaVal}>{row.namespace}</span>
            </span>
            <span>
              node: <span className={styles.metaVal}>{meta.node}</span>
            </span>
            <span>
              age: <span className={styles.metaVal}>{ageText(meta.creationTs, now)}</span>
            </span>
            <span style={{ color: statusColor }}>{meta.status}</span>
          </div>
        ) : (
          <div className={styles.meta}>
            <span>
              kind: <span className={styles.metaVal}>{kindLabel}</span>
            </span>
            {row.namespace && (
              <span>
                ns: <span className={styles.metaVal}>{row.namespace}</span>
              </span>
            )}
          </div>
        )}

        <div className={styles.tabs}>
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </div>
          ))}
        </div>
      </div>

      {activeTab === "logs" && isPod && <LogsTab />}
      {/* Mirrors the tab list above: Properties is no longer pod-only (B18). */}
      {activeTab === "properties" && KINDS_WITH_PROPERTIES.has(nav) && <PropertiesTab />}
      {/* Mounting is what starts the scraper, so this must mirror the tab list. */}
      {activeTab === "metrics" && nav === "nodes" && <MetricsTab />}
      {activeTab === "shell" && isPod && <ShellTab />}
      {/* A node's shell is a privileged debug pod rather than a container exec
          (B53), so it's a different component behind the same tab. */}
      {activeTab === "shell" && nav === "nodes" && <NodeShellTab />}
      {activeTab === "yaml" && <YamlTab />}
      {activeTab === "events" && <EventsTab />}
    </div>
  );
}

/**
 * Node drain progress (B20): evicted/total, plus the pods that wouldn't go.
 * The judgement about how it reads (a PDB block is not a failure) lives in
 * lib/drain.ts, where it's tested.
 */
function DrainBanner({ progress }: { progress: DrainProgress }) {
  const tone = drainTone(progress);
  const blocked = pdbBlocked(progress);
  const errored = drainErrors(progress);

  return (
    <div className={styles.drainBanner} style={{ borderColor: toneColor(tone) }}>
      <div className={styles.drainLine}>
        <span style={{ color: toneColor(tone) }}>{drainSummary(progress)}</span>
        {!progress.done && <span className={styles.drainSpinner}>…</span>}
      </div>
      {blocked.length > 0 && (
        <div className={styles.drainDetail}>
          {blocked.length} pod{blocked.length > 1 ? "s" : ""} held by a PodDisruptionBudget —
          they need more replicas elsewhere, or the budget relaxed:{" "}
          {blocked.map((f) => f.pod).join(", ")}
        </div>
      )}
      {errored.map((f) => (
        <div key={f.pod} className={styles.drainDetail} style={{ color: toneColor("err") }}>
          {f.pod}: {f.message}
        </div>
      ))}
    </div>
  );
}

/**
 * Age for the header: format an RFC3339 timestamp (real mode), or fall back to the
 * raw string (demo mode stores a literal age like "4d2h").
 */
function ageText(creationTs: string, now: number): string {
  const formatted = formatAge(creationTs, now);
  return formatted || creationTs;
}
