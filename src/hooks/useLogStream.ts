/**
 * Manages a pod's log stream lifecycle for the Logs tab.
 *
 * Behavior (Design §4-Logs, B29):
 *  - Streams only while `following` is true; pausing stops the backend stream
 *    entirely (no lines arrive) and freezes the buffer.
 *  - Resuming backfills from the last received line's wall-clock time (`sinceTime`)
 *    so the gap is filled without duplicating lines already shown.
 *  - Changing pod, container, the since window, or the previous toggle resets the
 *    backfill anchor and re-seeds via `tail` — each is a different set of lines,
 *    not a continuation of the last one.
 *  - **Previous is a snapshot, not a stream** (B29): the previous container is
 *    dead, so the read dumps what it printed and ends. Following it is
 *    meaningless, so it ignores the pause state and its ending isn't an error.
 *
 * Mounted by LogsTab, so the stream also stops when the user leaves the Logs tab.
 */

import { useEffect, useRef } from "react";
import { getProvider } from "../providers";
import { useStore, LOG_BUFFER_CAP } from "../store";
import { sinceSeconds } from "../lib/logview";
import type { LogHandle } from "../providers/types";

export function useLogStream(): void {
  const pod = useStore((s) => s.selectedRow);
  const following = useStore((s) => s.following);
  const containerIndex = useStore((s) => s.containerIndex);
  const previous = useStore((s) => s.logPrevious);
  const since = useStore((s) => s.logSince);
  const appendLogs = useStore((s) => s.appendLogs);
  const setFollowing = useStore((s) => s.setFollowing);

  // For multi-container pods, add an "all" option ("") after each container, so the
  // default (index 0) is still the first container.
  const containers = pod?.pod?.containers ?? [];
  const options = containers.length > 1 ? [...containers, ""] : containers;
  // null → no pod; "" → all containers; else a specific container name.
  const container = options.length ? options[containerIndex % options.length] : null;

  // Wall-clock time of the last received line, used as the resume anchor. Reset
  // whenever the read itself changes — a new pod, container, window or generation
  // is a genuinely new stream, not a resume.
  const lastActivity = useRef(0);
  useEffect(() => {
    lastActivity.current = 0;
  }, [pod?.uid, container, previous, since]);

  useEffect(() => {
    // container === "" is valid (all containers); only null means "no pod".
    if (!pod || !pod.pod || container === null) return;
    // Pausing stops a live stream. A previous read has nothing to pause: it's a
    // finite dump, and gating it on `following` would leave the tab empty for a
    // user who paused before switching to it.
    if (!previous && !following) return;

    const provider = getProvider();
    let handle: LogHandle | null = null;
    let cancelled = false;

    // First open (no prior activity) seeds via tail; a resume backfills via
    // sinceTime from where we left off.
    const sinceTime = lastActivity.current
      ? new Date(lastActivity.current).toISOString()
      : undefined;

    void (async () => {
      handle = await provider.startLogs(
        { kind: "pods", namespace: pod.namespace, name: pod.name },
        container,
        {
          tail: sinceTime ? undefined : LOG_BUFFER_CAP,
          sinceTime,
          sinceSeconds: sinceSeconds(since),
          previous,
        },
        (lines) => {
          if (cancelled) return;
          lastActivity.current = Date.now();
          appendLogs(lines);
        },
        (reason) => {
          if (cancelled) return;
          if (previous) {
            // Reaching the end of a dead container's log is the expected outcome,
            // not a failure — say so, and leave the follow state alone.
            appendLogs([{ ts: "", level: "", msg: "— end of previous container's log" }]);
            return;
          }
          // Surface the close reason as a muted line and flip to paused so the
          // user can retry (Story 6.2).
          appendLogs([{ ts: "", level: "", msg: `— stream closed: ${reason}` }]);
          setFollowing(false);
        },
      );
      // If the effect was torn down before the stream attached, stop it now.
      if (cancelled) handle.stop();
    })();

    return () => {
      cancelled = true;
      handle?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pod?.uid, container, following, previous, since]);
}
