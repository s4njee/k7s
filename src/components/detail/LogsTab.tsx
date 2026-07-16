/**
 * Logs tab UI (Design §4-Logs): filter/search, container cycler, timestamp toggle,
 * follow/pause control, the streaming log viewport (auto-scrolls while following),
 * and the footer strip. The stream lifecycle lives in useLogStream.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import styles from "./LogsTab.module.css";
import { useStore } from "../../store";
import { useLogStream } from "../../hooks/useLogStream";
import type { LogLine } from "../../providers/types";

/** Color per log level for the level column. */
const LEVEL_COLOR: Record<string, string> = {
  INFO: "var(--accent)",
  WARN: "var(--status-warn)",
  ERROR: "var(--status-err)",
  DEBUG: "var(--text-muted)",
};

/** Message tint: ERROR/WARN get soft tints, everything else is secondary. */
function msgColor(level: string): string {
  if (level === "ERROR") return "var(--status-err-msg)";
  if (level === "WARN") return "var(--status-warn-msg)";
  return "var(--text-secondary)";
}

export function LogsTab() {
  // Drive the stream for as long as this tab is mounted.
  useLogStream();

  const pod = useStore((s) => s.selectedRow);
  const logBuffer = useStore((s) => s.logBuffer);
  const logSearch = useStore((s) => s.logSearch);
  const setLogSearch = useStore((s) => s.setLogSearch);
  const showTimestamps = useStore((s) => s.showTimestamps);
  const toggleTimestamps = useStore((s) => s.toggleTimestamps);
  const following = useStore((s) => s.following);
  const toggleFollow = useStore((s) => s.toggleFollow);
  const containerIndex = useStore((s) => s.containerIndex);
  const cycleContainer = useStore((s) => s.cycleContainer);

  // Multi-container pods get an "all" option ("") first; "(all)" is its label and
  // turns on the per-line container tag column.
  const containers = pod?.pod?.containers ?? [];
  const options = containers.length > 1 ? [...containers, ""] : containers;
  const current = options.length ? options[containerIndex % options.length] : "";
  const containerLabel = current === "" ? "(all)" : current;
  const showContainerTag = current === "" && containers.length > 1;

  // Client-side filter on message + level (buffer itself is untouched).
  const filtered = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    if (!q) return logBuffer;
    return logBuffer.filter(
      (l) => l.msg.toLowerCase().includes(q) || l.level.toLowerCase().includes(q),
    );
  }, [logBuffer, logSearch]);

  // Auto-scroll to the bottom on new lines, but only while following.
  const viewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (following && viewportRef.current) {
      const el = viewportRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [filtered.length, following]);

  // When resuming (following flips on), jump to bottom immediately.
  useEffect(() => {
    if (following && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [following]);

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <span className={styles.searchIcon}>⌕</span>
          <input
            className={styles.searchInput}
            value={logSearch}
            onChange={(e) => setLogSearch(e.target.value)}
            placeholder="filter logs…"
          />
        </div>

        {/* Container cycler (cycles through the pod's containers, plus "all"). */}
        <div className={styles.button} onClick={cycleContainer} title="container">
          <span className={styles.buttonGlyph}>▣</span>
          {containerLabel}
          {options.length > 1 && <span className={styles.buttonChevron}>▼</span>}
        </div>

        {/* Timestamp toggle. */}
        <div
          className={`${styles.toggle} ${showTimestamps ? styles.toggleActive : ""}`}
          onClick={toggleTimestamps}
        >
          ts
        </div>

        {/* Follow / pause. */}
        <div
          className={`${styles.follow} ${following ? styles.following : styles.paused}`}
          onClick={toggleFollow}
        >
          {following ? "⏸ pause" : "▶ follow"}
        </div>
      </div>

      <div className={styles.viewport} ref={viewportRef}>
        {filtered.map((line, i) => (
          <LogRow key={i} line={line} showTs={showTimestamps} showContainer={showContainerTag} />
        ))}
      </div>

      <div className={styles.footer}>
        <span>{filtered.length} lines</span>
        <span>container: {containerLabel}</span>
        <span style={{ color: following ? "var(--status-ok)" : "var(--status-warn)" }}>
          {following ? "● streaming" : "⏸ paused"}
        </span>
      </div>
    </>
  );
}

/** A single log line row: timestamp (optional), container tag (in "all" mode),
 *  level column, message. */
function LogRow({
  line,
  showTs,
  showContainer,
}: {
  line: LogLine;
  showTs: boolean;
  showContainer: boolean;
}) {
  return (
    <div className={styles.line}>
      {showTs && <span className={styles.lineTs}>{line.ts}</span>}
      {showContainer && <span className={styles.lineContainer}>{line.container}</span>}
      <span className={styles.lineLevel} style={{ color: LEVEL_COLOR[line.level] ?? "var(--text-muted)" }}>
        {line.level}
      </span>
      <span className={styles.lineMsg} style={{ color: msgColor(line.level) }}>
        {line.msg}
      </span>
    </div>
  );
}
