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
  const row = useStore((s) => s.selectedRow);
  const kind = useStore((s) => s.nav);
  const [events, setEvents] = useState<EventItem[] | null>(null);

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setEvents(null); // show loading while fetching
    void getProvider()
      .getEvents({ kind, namespace: row.namespace, name: row.name })
      .then((items) => {
        if (!cancelled) setEvents(items);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [row?.uid, row?.namespace, row?.name, kind]);

  if (events === null) {
    return <div className={styles.empty}>loading events…</div>;
  }
  if (events.length === 0) {
    // Empty is the normal case for a healthy, long-running object: the API server
    // drops events after ~1h, so silence here means "nothing lately", not "never".
    // Say so, and point at the cluster feed which is where problems surface (B14).
    return (
      <div className={styles.empty}>
        no recent events — events expire after ~1h
        <div className={styles.emptyHint}>see Cluster → Events for the live feed</div>
      </div>
    );
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
