/**
 * Sidebar composition (Design §1): cluster switcher, scrollable nav, watch footer.
 */

import styles from "./Sidebar.module.css";
import { ClusterSwitcher } from "./ClusterSwitcher";
import { NavList } from "./NavList";
import { WatchFooter } from "./WatchFooter";

export function Sidebar() {
  // data-surface="panel": in light mode the sidebar is dark chrome (tokens.css).
  return (
    <div className={styles.sidebar} data-surface="panel">
      <ClusterSwitcher />
      <NavList />
      <WatchFooter />
    </div>
  );
}
