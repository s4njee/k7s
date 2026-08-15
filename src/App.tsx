/**
 * App root — the single-window shell (Design §Overview).
 *
 * Layout: Sidebar | (TopBar / content / StatusBar). The content region hosts the
 * resource table and pod detail panel (added in Epics 4 and 5); for now it shows a
 * placeholder so the shell (sidebar, top bar, status bar) can be verified.
 */

import styles from "./App.module.css";
import { useBootstrap } from "./hooks/useBootstrap";
import { useCustomKindWatch } from "./hooks/useCustomKindWatch";
import { useGlobalKeys } from "./hooks/useGlobalKeys";
import { useProblemNotifications } from "./hooks/useProblemNotifications";
import { useTheme } from "./hooks/useTheme";
import { useUpdates } from "./hooks/useUpdates";
import { Sidebar } from "./components/sidebar/Sidebar";
import { TopBar } from "./components/topbar/TopBar";
import { StatusBar } from "./components/statusbar/StatusBar";
import { ResourceTable } from "./components/table/ResourceTable";
import { DetailPanel } from "./components/detail/DetailPanel";
import { ForwardsBar } from "./components/forwards/ForwardsBar";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { CreateYaml } from "./components/create/CreateYaml";
import { CommandPalette } from "./components/palette/CommandPalette";

export default function App() {
  // Wire provider → store and connect on mount.
  useBootstrap();
  // App-level keyboard shortcuts (Esc cascade, detail tab cycling).
  useGlobalKeys();
  // Watch the open CRD kind, and only that one (B15).
  useCustomKindWatch();
  // Apply the colour palette to <html> and follow the OS when set to "system" (B52).
  useTheme();
  // Native problem notifications when opted in (B50).
  useProblemNotifications();
  // Passive update checks (B72): on launch and once a day, silent on failure.
  useUpdates();

  return (
    <div className={styles.app}>
      <Sidebar />
      <div className={styles.main}>
        <TopBar />
        <div className={styles.content}>
          <ResourceTable />
          <DetailPanel />
        </div>
        <ForwardsBar />
        <StatusBar />
      </div>
      {/* Modals, outside the layout flow. The palette is last so it layers over
          everything — ⌘K works from anywhere, including the settings panel. */}
      <SettingsPanel />
      <CreateYaml />
      <CommandPalette />
    </div>
  );
}
