/**
 * Pod detail panel (Design §4). Opens for the selected pod; shows a header with
 * status/name/meta, a Logs/YAML/Events tab strip, and the active tab's content.
 * Only pods open this panel in v1 (per the design).
 */

import styles from "./DetailPanel.module.css";
import { useStore, type DetailTab } from "../../store";
import { useNow } from "../../hooks/useNow";
import { formatAge } from "../../lib/format";
import { toneColor } from "../../lib/tone";
import { LogsTab } from "./LogsTab";
import { YamlTab } from "./YamlTab";
import { EventsTab } from "./EventsTab";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "logs", label: "Logs" },
  { id: "yaml", label: "YAML" },
  { id: "events", label: "Events" },
];

export function DetailPanel() {
  const pod = useStore((s) => s.selectedPod);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeDetail = useStore((s) => s.closeDetail);
  const now = useNow();

  // Panel is closed when no pod is selected.
  if (!pod || !pod.pod) return null;
  const meta = pod.pod;
  const statusColor = toneColor(meta.statusTone);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.statusDot} style={{ background: statusColor }} />
          <div className={styles.name} title={pod.name}>
            {pod.name}
          </div>
          <div className={styles.close} onClick={closeDetail} title="close">
            ×
          </div>
        </div>

        <div className={styles.meta}>
          <span>
            ns: <span className={styles.metaVal}>{pod.namespace}</span>
          </span>
          <span>
            node: <span className={styles.metaVal}>{meta.node}</span>
          </span>
          <span>
            age: <span className={styles.metaVal}>{ageText(meta.creationTs, now)}</span>
          </span>
          <span style={{ color: statusColor }}>{meta.status}</span>
        </div>

        <div className={styles.tabs}>
          {TABS.map((t) => (
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

      {activeTab === "logs" && <LogsTab />}
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
