/**
 * Manages a pod's log stream lifecycle for the Logs tab.
 *
 * Behavior (Design §4-Logs):
 *  - Streams only while `following` is true; pausing stops the backend stream
 *    entirely (no lines arrive) and freezes the buffer.
 *  - Resuming backfills from the last received line's wall-clock time (`sinceTime`)
 *    so the gap is filled without duplicating lines already shown.
 *  - Changing pod or container resets the backfill anchor and re-seeds via `tail`.
 *
 * Mounted by LogsTab, so the stream also stops when the user leaves the Logs tab.
 */

import { useEffect, useRef } from "react";
import { getProvider } from "../providers";
import { useStore, LOG_BUFFER_CAP } from "../store";
import type { LogHandle } from "../providers/types";

export function useLogStream(): void {
  const pod = useStore((s) => s.selectedPod);
  const following = useStore((s) => s.following);
  const containerIndex = useStore((s) => s.containerIndex);
  const appendLogs = useStore((s) => s.appendLogs);
  const setFollowing = useStore((s) => s.setFollowing);

  const containers = pod?.pod?.containers ?? [];
  const container = containers.length ? containers[containerIndex % containers.length] : null;

  // Wall-clock time of the last received line, used as the resume anchor. Reset
  // whenever the pod or container changes (a genuinely new stream, not a resume).
  const lastActivity = useRef(0);
  useEffect(() => {
    lastActivity.current = 0;
  }, [pod?.uid, container]);

  useEffect(() => {
    if (!pod || !pod.pod || !container || !following) return;

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
        { tail: sinceTime ? undefined : LOG_BUFFER_CAP, sinceTime },
        (lines) => {
          if (cancelled) return;
          lastActivity.current = Date.now();
          appendLogs(lines);
        },
        (reason) => {
          if (cancelled) return;
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
  }, [pod?.uid, container, following]);
}
