/**
 * Sidebar composition (Design §1): cluster switcher, scrollable nav, watch footer.
 */

import styles from "./Sidebar.module.css";
import { ClusterSwitcher } from "./ClusterSwitcher";
import { NavList } from "./NavList";
import { WatchFooter } from "./WatchFooter";

export function Sidebar() {
  return (
    <div className={styles.sidebar}>
      <ClusterSwitcher />
      <NavList />
      <WatchFooter />
    </div>
  );
}
