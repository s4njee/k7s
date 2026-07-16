/**
 * Active port-forwards strip (B6). Renders above the status bar whenever there are
 * live forwards, each as `localhost:PORT → pod:REMOTE` with a ✕ to stop it.
 */

import styles from "./ForwardsBar.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";

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
        <span key={f.id} className={styles.item}>
          <span className={styles.local}>localhost:{f.localPort}</span>
          <span className={styles.arrow}>→</span>
          <span className={styles.target}>
            {f.pod}:{f.remotePort}
          </span>
          <span className={styles.stop} title="stop forward" onClick={() => void stop(f.id)}>
            ✕
          </span>
        </span>
      ))}
    </div>
  );
}
