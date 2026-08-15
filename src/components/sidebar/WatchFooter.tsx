/**
 * Sidebar footer (Design §1): a pulsing dot + "watch: N streams active", where N
 * is the live watcher + log-stream count reported by the backend — plus the gear
 * that opens Settings (B23).
 */

import styles from "./Sidebar.module.css";
import { useStore } from "../../store";

export function WatchFooter() {
  const watchCount = useStore((s) => s.watchCount);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  return (
    <div className={styles.footer}>
      <span className={styles.footerDot} />
      <span className={styles.footerText}>watch: {watchCount} streams active</span>
      <button
        type="button"
        className={styles.gear}
        title="settings"
        aria-label="settings"
        onClick={() => setSettingsOpen(true)}
      >
        ⚙
      </button>
    </div>
  );
}
