/**
 * Detail panel (Design §4). Opens for the selected row. Pods get a header with
 * status/node/age and a Logs/YAML/Events tab strip; other kinds get a simpler
 * header and YAML/Events only (no logs). The selected row's kind is the current
 * nav kind, since selection is cleared whenever nav changes.
 */

import { useState } from "react";
import styles from "./DetailPanel.module.css";
import { useStore, type DetailTab } from "../../store";
import { useNow } from "../../hooks/useNow";
import { formatAge } from "../../lib/format";
import { toneColor } from "../../lib/tone";
import { kindMeta } from "../../lib/kinds";
import { LogsTab } from "./LogsTab";
import { PropertiesTab } from "./PropertiesTab";
import { ShellTab } from "./ShellTab";
import { YamlTab } from "./YamlTab";
import { EventsTab } from "./EventsTab";
import { ActionsMenu } from "./ActionsMenu";

const ALL_TABS: { id: DetailTab; label: string }[] = [
  { id: "logs", label: "Logs" },
  { id: "properties", label: "Properties" },
  { id: "shell", label: "Shell" },
  { id: "yaml", label: "YAML" },
  { id: "events", label: "Events" },
];

/** Tabs available only for pods (the others apply to every kind). */
const POD_ONLY_TABS = new Set<DetailTab>(["logs", "properties", "shell"]);

export function DetailPanel() {
  const row = useStore((s) => s.selectedRow);
  const nav = useStore((s) => s.nav);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeDetail = useStore((s) => s.closeDetail);
  const customKinds = useStore((s) => s.customKinds);
  const now = useNow();

  // Error from an action (delete/scale/cordon), shown as a header banner.
  const [actionError, setActionError] = useState<string | null>(null);

  // Panel is closed when nothing is selected.
  if (!row) return null;

  const meta = row.pod; // present only for pods
  const isPod = !!meta;
  // Logs/Shell are pod-only; other kinds get YAML + Events.
  const tabs = isPod ? ALL_TABS : ALL_TABS.filter((t) => !POD_ONLY_TABS.has(t.id));
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
      {activeTab === "properties" && isPod && <PropertiesTab />}
      {activeTab === "shell" && isPod && <ShellTab />}
      {activeTab === "yaml" && <YamlTab />}
      {activeTab === "events" && <EventsTab />}
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
