/**
 * Active port-forwards strip (B6, B16). Renders above the status bar whenever
 * there are live forwards, each as `localhost:PORT → target:REMOTE` with a ✕ to
 * stop it. Clicking the local address copies it.
 *
 * A Service forward (B16) shows the service name — that's what the user asked to
 * forward — with the pod it actually resolved to in the tooltip. A forward whose
 * connections are failing turns red but stays listed: its listener is still bound
 * and the pod may come back.
 */

import styles from "./ForwardsBar.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import type { ForwardInfo } from "../../providers/types";

export function ForwardsBar() {
  const forwards = useStore((s) => s.portForwards);
  const setPortForwards = useStore((s) => s.setPortForwards);

  if (forwards.length === 0) return null;

  const stop = async (id: string) => {
    await getProvider().stopPortForward(id);
    setPortForwards(await getProvider().listPortForwards());
  };

  return (
    <div className={styles.bar}>
      <span className={styles.label}>forwards:</span>
      {forwards.map((f) => (
        <span
          key={f.id}
          className={`${styles.item} ${f.error ? styles.itemError : ""}`}
          title={tooltip(f)}
        >
          <span
            className={styles.local}
            title="copy address"
            onClick={() => void copy(`localhost:${f.localPort}`)}
          >
            localhost:{f.localPort}
          </span>
          <span className={styles.arrow}>→</span>
          <span className={styles.target}>
            {f.service ?? f.pod}:{f.servicePort ?? f.remotePort}
          </span>
          {f.error && <span className={styles.errorMark}>!</span>}
          <span className={styles.stop} title="stop forward" onClick={() => void stop(f.id)}>
            ✕
          </span>
        </span>
      ))}
    </div>
  );
}

/** Full detail on hover: the resolved pod and port for services, and any failure. */
function tooltip(f: ForwardInfo): string {
  // The strip shows the port asked for; the tooltip is where the resolved
  // targetPort belongs, since that's the detail you'd want when debugging.
  const base = f.service
    ? `${f.namespace}/service ${f.service}:${f.servicePort ?? f.remotePort}` +
      ` → pod ${f.pod}:${f.remotePort}`
    : `${f.namespace}/pod ${f.pod}:${f.remotePort}`;
  return f.error ? `${base}\n${f.error}` : base;
}

/** Copy silently; the address stays visible either way. */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Non-fatal.
  }
}
