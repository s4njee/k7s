/**
 * Status bar (Design §5): connection indicator, API latency, nodes ready, cluster
 * CPU/MEM %, and the active kubectl context. Values come from `cluster-status`;
 * CPU/MEM show "—" when metrics are unavailable.
 */

import styles from "./StatusBar.module.css";
import { useStore } from "../../store";

export function StatusBar() {
  const connection = useStore((s) => s.connection);
  const status = useStore((s) => s.clusterStatus);

  const connected = connection.phase === "connected";
  const cluster = connection.clusterName ?? connection.context ?? "k7s";
  const ctx = connection.context ?? "—";

  // Percent values render "—" when metrics are absent (null).
  const cpu = status?.cpuPercent != null ? `${status.cpuPercent}%` : "—";
  const mem = status?.memPercent != null ? `${status.memPercent}%` : "—";

  return (
    <div className={styles.statusbar}>
      <span
        className={styles.cluster}
        style={{ color: connected ? "var(--status-ok)" : "var(--status-err)" }}
      >
        ● {cluster}
      </span>
      <span>api: {status ? `${status.apiLatencyMs}ms` : "—"}</span>
      <span>
        nodes {status ? `${status.nodesReady}/${status.nodesTotal}` : "0/0"} ready
      </span>
      <span>cpu {cpu}</span>
      <span>mem {mem}</span>
      <div className={styles.spacer} />
      <span>kubectl ctx: {ctx}</span>
    </div>
  );
}
