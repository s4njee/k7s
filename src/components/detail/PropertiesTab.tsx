/**
 * Properties tab (B13): what the selected pod is actually wired to — placement,
 * containers, attached volumes (with PVC → PV resolved: capacity, storage class,
 * access modes, phase, mount paths), and the Services whose selector matches it,
 * plus labels/annotations. Fetched in one backend call on open / pod change.
 */

import { useEffect, useState } from "react";
import styles from "./PropertiesTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useNow } from "../../hooks/useNow";
import { formatAge } from "../../lib/format";
import { toneColor } from "../../lib/tone";
import type { PodProperties } from "../../providers/types";

export function PropertiesTab() {
  const pod = useStore((s) => s.selectedRow);
  const [props, setProps] = useState<PodProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!pod) return;
    let cancelled = false;
    setProps(null);
    setError(null);
    void getProvider()
      .getPodProperties({ kind: "pods", namespace: pod.namespace, name: pod.name })
      .then((p) => {
        if (!cancelled) setProps(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [pod?.uid, pod?.namespace, pod?.name]);

  if (error) return <div className={styles.state}>{error}</div>;
  if (!props) return <div className={styles.state}>loading properties…</div>;

  // Started: format the RFC3339 start time as an age (blank when unset).
  const started = props.startTime ? formatAge(props.startTime, now) : "—";
  const pvcVolumes = props.volumes.filter((v) => v.kind === "PVC");
  const otherVolumes = props.volumes.filter((v) => v.kind !== "PVC");

  return (
    <div className={styles.wrap}>
      {/* ---- Overview ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>Overview</div>
        <div className={styles.grid}>
          <Row k="node" v={props.node} />
          <Row k="pod IP" v={props.podIp} />
          <Row k="host IP" v={props.hostIp} />
          <Row k="QoS" v={props.qosClass} />
          <Row k="owner" v={props.owner} />
          <Row k="service account" v={props.serviceAccount} />
          <Row k="restart policy" v={props.restartPolicy} />
          <Row k="priority class" v={props.priorityClass} />
          <Row k="started" v={started} />
        </div>
      </div>

      {/* ---- Containers ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>Containers ({props.containers.length})</div>
        <table className={styles.table}>
          <thead>
            <tr>
              {["NAME", "IMAGE", "STATE", "READY", "RESTARTS", "CPU R/L", "MEM R/L", "PORTS"].map(
                (h) => (
                  <th key={h} className={styles.th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {props.containers.map((c) => (
              <tr key={c.name}>
                <td className={`${styles.td} ${styles.tdName}`}>{c.name}</td>
                <td className={`${styles.td} ${styles.tdWrap}`}>{c.image}</td>
                <td className={styles.td} style={{ color: stateColor(c.state) }}>
                  {c.state}
                </td>
                <td className={styles.td} style={{ color: toneColor(c.ready ? "ok" : "warn") }}>
                  {c.ready ? "yes" : "no"}
                </td>
                <td className={styles.td} style={{ color: toneColor(c.restarts > 5 ? "err" : "secondary") }}>
                  {c.restarts}
                </td>
                <td className={styles.td}>{c.cpu}</td>
                <td className={styles.td}>{c.memory}</td>
                <td className={styles.td}>{c.ports}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---- Storage (PVC-backed volumes) ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>Storage ({pvcVolumes.length})</div>
        {pvcVolumes.length === 0 ? (
          <div className={styles.empty}>no persistent volumes attached</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                {["VOLUME", "CLAIM", "PV", "CAPACITY", "CLASS", "ACCESS", "PHASE", "MOUNTED AT"].map(
                  (h) => (
                    <th key={h} className={styles.th}>
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {pvcVolumes.map((v) => (
                <tr key={v.name}>
                  <td className={`${styles.td} ${styles.tdName}`}>{v.name}</td>
                  <td className={styles.td}>{v.claim}</td>
                  <td className={`${styles.td} ${styles.tdWrap}`}>{v.pv}</td>
                  <td className={styles.td}>{v.capacity}</td>
                  <td className={styles.td}>{v.storageClass}</td>
                  <td className={styles.td}>{v.accessModes}</td>
                  <td className={styles.td} style={{ color: toneColor(v.phase === "Bound" ? "ok" : "warn") }}>
                    {v.phase}
                  </td>
                  <td className={`${styles.td} ${styles.tdWrap}`}>
                    {v.mountPaths}
                    {v.readOnly ? " (ro)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---- Services selecting this pod ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>Services ({props.services.length})</div>
        {props.services.length === 0 ? (
          <div className={styles.empty}>no services select this pod</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                {["NAME", "TYPE", "CLUSTER-IP", "PORTS"].map((h) => (
                  <th key={h} className={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.services.map((s) => (
                <tr key={s.name}>
                  <td className={`${styles.td} ${styles.tdName}`}>{s.name}</td>
                  <td className={styles.td}>{s.type}</td>
                  <td className={styles.td}>{s.clusterIp}</td>
                  <td className={styles.td}>{s.ports}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---- Other volumes (config/secret/projected/…) ---- */}
      {otherVolumes.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>Other volumes ({otherVolumes.length})</div>
          <table className={styles.table}>
            <thead>
              <tr>
                {["VOLUME", "KIND", "MOUNTED AT"].map((h) => (
                  <th key={h} className={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {otherVolumes.map((v) => (
                <tr key={v.name}>
                  <td className={`${styles.td} ${styles.tdName}`}>{v.name}</td>
                  <td className={styles.td}>{v.kind}</td>
                  <td className={`${styles.td} ${styles.tdWrap}`}>
                    {v.mountPaths}
                    {v.readOnly ? " (ro)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Labels / annotations ---- */}
      {props.labels.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>Labels</div>
          <div className={styles.chips}>
            {props.labels.map((l) => (
              <span key={l.key} className={styles.chip} title={`${l.key}=${l.value}`}>
                <span className={styles.chipKey}>{l.key}</span>
                <span className={styles.chipVal}>{l.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {props.annotations.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>Annotations</div>
          <div className={styles.chips}>
            {props.annotations.map((a) => (
              <span key={a.key} className={styles.chip} title={`${a.key}=${a.value}`}>
                <span className={styles.chipKey}>{a.key}</span>
                <span className={styles.chipVal}>{a.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One key/value row in the overview grid. */
function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className={styles.gridKey}>{k}</span>
      <span className={styles.gridVal}>{v}</span>
    </>
  );
}

/** Color a container state like the table statuses. */
function stateColor(state: string): string {
  if (state.startsWith("Running")) return toneColor("ok");
  if (state.startsWith("Waiting")) return toneColor("warn");
  if (state.startsWith("Terminated")) return toneColor("err");
  return toneColor("secondary");
}
