/**
 * Events tab (Design §4-Events). Fetches events for the selected pod on open (and
 * on pod change) and renders them as cards: Normal (green) / Warning (red).
 */

import { useEffect, useState } from "react";
import styles from "./EventsTab.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import type { EventItem } from "../../providers/types";

export function EventsTab() {
  const pod = useStore((s) => s.selectedPod);
  const [events, setEvents] = useState<EventItem[] | null>(null);

  useEffect(() => {
    if (!pod) return;
    let cancelled = false;
    setEvents(null); // show loading while fetching
    void getProvider()
      .getEvents({ kind: "pods", namespace: pod.namespace, name: pod.name })
      .then((items) => {
        if (!cancelled) setEvents(items);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pod?.uid, pod?.namespace, pod?.name]);

  if (events === null) {
    return <div className={styles.empty}>loading events…</div>;
  }
  if (events.length === 0) {
    return <div className={styles.empty}>no events</div>;
  }

  return (
    <div className={styles.list}>
      {events.map((ev, i) => (
        <div key={i} className={styles.card}>
          <span
            className={styles.type}
            style={{ color: ev.type === "Warning" ? "var(--status-err)" : "var(--status-ok)" }}
          >
            {ev.type}
          </span>
          <div className={styles.body}>
            <div className={styles.headline}>
              <span className={styles.reason}>{ev.reason}</span>
              <span className={styles.meta}>
                {ev.age} · ×{ev.count}
              </span>
            </div>
            <div className={styles.message}>{ev.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
