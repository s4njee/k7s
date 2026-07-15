/**
 * Sidebar footer (Design §1): a pulsing dot + "watch: N streams active", where N
 * is the live watcher + log-stream count reported by the backend.
 */

import styles from "./Sidebar.module.css";
import { useStore } from "../../store";

export function WatchFooter() {
  const watchCount = useStore((s) => s.watchCount);
  return (
    <div className={styles.footer}>
      <span className={styles.footerDot} />
      watch: {watchCount} streams active
    </div>
  );
}
