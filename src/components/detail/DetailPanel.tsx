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
import { useStore, type DetailTab } from "../../store";
import { useNow } from "../../hooks/useNow";
import { formatAge } from "../../lib/format";
import { toneColor } from "../../lib/tone";
import { kindMeta, KINDS_WITH_PROPERTIES } from "../../lib/kinds";
import { LogsTab } from "./LogsTab";
import { PropertiesTab } from "./PropertiesTab";
import { ShellTab } from "./ShellTab";
import { YamlTab } from "./YamlTab";
import { EventsTab } from "./EventsTab";
import { ActionsMenu } from "./ActionsMenu";
import type { DrainProgress } from "../../providers/types";

const ALL_TABS: { id: DetailTab; label: string }[] = [
  { id: "logs", label: "Logs" },
  { id: "properties", label: "Properties" },
  { id: "shell", label: "Shell" },
  { id: "yaml", label: "YAML" },
  { id: "events", label: "Events" },
];

/**
 * Tabs that need a running container, so they only apply to pods. Properties is
 * no longer among them: it shows for any kind with a gatherer (B18).
 */
const POD_ONLY_TABS = new Set<DetailTab>(["logs", "shell"]);

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
  // Logs/Shell need a container, so they're pod-only. Properties shows only for
  // kinds with a gatherer — otherwise it'd be a tab that only ever errors (B18).
  const tabs = ALL_TABS.filter((t) => {
    if (POD_ONLY_TABS.has(t.id)) return isPod;
    if (t.id === "properties") return KINDS_WITH_PROPERTIES.has(nav);
    return true;
  });
  const statusColor = meta ? toneColor(meta.statusTone) : "var(--text-muted)";
  // Custom kinds resolve their label from discovery, so this is a runtime lookup.
  const kindLabel = kindMeta(nav, customKinds)?.label ?? nav;

  return (
    <div className={styles.panel}>
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
      {activeTab === "shell" && isPod && <ShellTab />}
      {activeTab === "yaml" && <YamlTab />}
      {activeTab === "events" && <EventsTab />}
    </div>
  );
}

/**
 * Node drain progress (B20): evicted/total, plus the pods that wouldn't go.
 *
 * A PDB block is the expected sticking point rather than a failure — it means the
 * eviction would take a workload below its declared availability — so it reads
 * amber and says what to do, while a real error reads red.
 */
function DrainBanner({ progress }: { progress: DrainProgress }) {
  const { evicted, total, failures, done } = progress;
  const blocked = failures.filter((f) => f.blockedByPdb);
  const errored = failures.filter((f) => !f.blockedByPdb);
  const tone = errored.length ? "err" : blocked.length ? "warn" : done ? "ok" : "secondary";

  return (
    <div className={styles.drainBanner} style={{ borderColor: toneColor(tone) }}>
      <div className={styles.drainLine}>
        <span style={{ color: toneColor(tone) }}>
          {done ? "drain finished" : "draining"}: {evicted}/{total} evicted
        </span>
        {!done && <span className={styles.drainSpinner}>…</span>}
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
