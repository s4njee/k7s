/**
 * Settings panel (B23) — a modal over the app, opened by the sidebar's gear.
 *
 * Every change is applied and persisted immediately: there's no Save button,
 * because there's nothing here worth a confirmation step and a Cancel would imply
 * a rollback we don't implement. Values are sanitised on the way in (see
 * lib/settings.ts), so a half-typed field can't reach a ring buffer or a poll loop.
 *
 * Settings that can't take effect until the next connect say so, rather than
 * quietly doing nothing. The appearance settings (theme, font, accent, motion)
 * apply the moment they change — the panel is grouped so the ones you can watch
 * happen while you're here are first.
 */

import { useEffect } from "react";
import styles from "./SettingsPanel.module.css";
import { useStore } from "../../store";
import { LIMITS, DEFAULT_SETTINGS, sanitizeSettings, type Settings } from "../../lib/settings";
import { ACCENTS, UI_FONTS, type Accent } from "../../lib/appearance";
import { asTheme } from "../../lib/theme";
import { checkForUpdates, installUpdate, restartToApplyUpdate, openChangelog } from "../../lib/updates";
import { LOG_LEVELS } from "../../lib/settings";
import { exportDiagnostics } from "../../lib/diagnostics";

/** The swatch colour shown for each accent option (the dark-palette value). */
const ACCENT_SWATCH: Record<Accent, string> = {
  blue: "#4d9fff",
  green: "#34b37c",
  purple: "#b18cff",
  orange: "#ff9d4d",
};

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const connected = useStore((s) => s.connection.phase === "connected");
  const activeCid = useStore((s) => s.activeCid);
  const clusterName = useStore((s) => s.connection.clusterName ?? s.activeCid);
  const clusterNamespaces = useStore((s) => s.clusterNamespaces);
  const setClusterNamespace = useStore((s) => s.setClusterNamespace);

  // Automatic updates (B72): plain store state, driven by lib/updates.ts.
  const updateStatus = useStore((s) => s.status);
  const updateVersion = useStore((s) => s.version);
  const currentVersion = useStore((s) => s.currentVersion);

  // Esc closes, matching every other overlay in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  /** Apply one field, sanitised against the rest of the current settings. */
  const update = (patch: Partial<Settings>) => setSettings(sanitizeSettings({ ...settings, ...patch }));

  return (
    // Clicking the backdrop closes; clicking the panel must not bubble up to it.
    <div className={styles.backdrop} onClick={() => setOpen(false)}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Settings</span>
          <span className={styles.close} title="close" onClick={() => setOpen(false)}>
            ×
          </span>
        </div>

        <div className={styles.body}>
          {/* ---- Appearance: everything here applies the moment it changes,
               and its effects are visible behind the panel. ---- */}
          <Section title="Appearance">
            <Row label="Theme" hint="“system” follows your desktop’s light/dark setting">
              <select
                className={styles.select}
                value={settings.theme}
                onChange={(e) => update({ theme: asTheme(e.target.value) })}
              >
                <option value="system">system</option>
                <option value="dark">dark</option>
                <option value="light">light</option>
              </select>
            </Row>

            <Row label="UI font" hint="monospace is the design; sans serif re-sets the whole app">
              <div className={styles.seg}>
                {UI_FONTS.map((f) => (
                  <button
                    key={f}
                    className={`${styles.segBtn} ${settings.uiFont === f ? styles.segActive : ""}`}
                    onClick={() => update({ uiFont: f })}
                  >
                    {f === "mono" ? "monospace" : "sans serif"}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Accent color" hint="active indicators, links, focus — in both themes">
              <div className={styles.swatches}>
                {ACCENTS.map((a) => (
                  <button
                    key={a}
                    className={`${styles.swatch} ${settings.accent === a ? styles.swatchActive : ""}`}
                    style={{ background: ACCENT_SWATCH[a] }}
                    onClick={() => update({ accent: a })}
                    title={a}
                    aria-pressed={settings.accent === a}
                  />
                ))}
              </div>
            </Row>

            <Row label="Reduce motion" hint="stops the pulsing “live” dot and other motion">
              <div
                className={`${styles.toggle} ${settings.reduceMotion ? styles.toggleOn : ""}`}
                onClick={() => update({ reduceMotion: !settings.reduceMotion })}
                role="switch"
                aria-checked={settings.reduceMotion}
              >
                {settings.reduceMotion ? "on" : "off"}
              </div>
            </Row>
          </Section>

          <Section title="Logs">
            <Row
              label="Log buffer"
              hint={`lines kept in the log view (${LIMITS.logBufferCap.min}–${LIMITS.logBufferCap.max}); applies immediately`}
            >
              <input
                className={styles.number}
                type="number"
                min={LIMITS.logBufferCap.min}
                max={LIMITS.logBufferCap.max}
                value={settings.logBufferCap}
                onChange={(e) => update({ logBufferCap: Number(e.target.value) })}
              />
            </Row>
          </Section>

          <Section title="Cluster">
            <Row
              label="Metrics poll"
              hint={`seconds between CPU/MEM polls${connected ? " — applies on next connect" : ""}`}
            >
              <input
                className={styles.number}
                type="number"
                min={LIMITS.metricsIntervalSecs.min}
                max={LIMITS.metricsIntervalSecs.max}
                value={settings.metricsIntervalSecs}
                onChange={(e) => update({ metricsIntervalSecs: Number(e.target.value) })}
              />
            </Row>

            <Row
              label="Status poll"
              hint={`seconds between cluster-status polls${connected ? " — applies on next connect" : ""}`}
            >
              <input
                className={styles.number}
                type="number"
                min={LIMITS.statusIntervalSecs.min}
                max={LIMITS.statusIntervalSecs.max}
                value={settings.statusIntervalSecs}
                onChange={(e) => update({ statusIntervalSecs: Number(e.target.value) })}
              />
            </Row>

            <Row label="Default namespace" hint="selected on connect; “all” for no filter">
              <input
                className={styles.text}
                value={settings.defaultNamespace}
                onChange={(e) => update({ defaultNamespace: e.target.value })}
                placeholder="all"
              />
            </Row>

            {activeCid && (
              <Row
                label={`Default namespace (${clusterName})`}
                hint="per-cluster override, layered over the global default above"
              >
                <input
                  className={styles.text}
                  value={clusterNamespaces[activeCid] ?? ""}
                  onChange={(e) => setClusterNamespace(activeCid, e.target.value)}
                  placeholder="inherit global"
                />
              </Row>
            )}

            <Row label="Notifications" hint="native notification when something goes wrong; never while the window is focused">
              <div
                className={`${styles.toggle} ${settings.notifications ? styles.toggleOn : ""}`}
                onClick={() => update({ notifications: !settings.notifications })}
                role="switch"
                aria-checked={settings.notifications}
              >
                {settings.notifications ? "on" : "off"}
              </div>
            </Row>
          </Section>

          <Section title="Shell">
            <Row label="Shell command" hint="blank uses bash if present, else sh; applies to the next shell">
              <input
                className={styles.text}
                value={settings.shellCommand}
                onChange={(e) => update({ shellCommand: e.target.value })}
                placeholder="(auto: bash or sh)"
              />
            </Row>

            <Row
              label="Node shell image"
              hint="blank uses nicolaka/netshoot; must be multi-arch on a mixed-arch cluster"
            >
              <input
                className={styles.text}
                value={settings.nodeShellImage}
                onChange={(e) => update({ nodeShellImage: e.target.value })}
                placeholder="(nicolaka/netshoot)"
              />
            </Row>
          </Section>

          <Section title="Software updates">
            <Row
              label="Version"
              hint="k7s checks for updates quietly on launch and once a day"
            >
              <div className={styles.updateLine}>
                <span className={styles.updateVersion}>{currentVersion ?? "—"}</span>
                <button
                  className={styles.updateBtn}
                  onClick={() => void checkForUpdates()}
                  disabled={updateStatus === "checking"}
                >
                  {updateStatus === "checking" ? "Checking…" : "Check for updates"}
                </button>
              </div>
            </Row>

            {updateStatus === "none" && (
              <div className={styles.updateNote}>You're up to date.</div>
            )}

            {(updateStatus === "available" || updateStatus === "downloading") &&
              updateVersion && (
                <div className={styles.updateNote}>
                  <span>Version {updateVersion} is available.</span>
                  <span className={styles.updateActions}>
                    <button
                      className={styles.updateBtn}
                      onClick={() => void openChangelog()}
                    >
                      What's new
                    </button>
                    <button
                      className={styles.updateBtn}
                      onClick={() => void installUpdate()}
                      disabled={updateStatus === "downloading"}
                    >
                      {updateStatus === "downloading" ? "Downloading…" : "Download & install"}
                    </button>
                  </span>
                </div>
              )}

            {updateStatus === "installed" && (
              <div className={styles.updateNote}>
                <span>Update installed. Restart k7s to finish applying it.</span>
                <span className={styles.updateActions}>
                  <button
                    className={styles.updateBtn}
                    onClick={() => void restartToApplyUpdate()}
                  >
                    Restart now
                  </button>
                </span>
              </div>
            )}
          </Section>

          <Section title="Diagnostics">
            <Row
              label="Log level"
              hint="what the app log file captures; more verbosity when troubleshooting"
            >
              <select
                className={styles.select}
                value={settings.logLevel}
                onChange={(e) => update({ logLevel: e.target.value as Settings["logLevel"] })}
              >
                {LOG_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Row>

            <Row
              label="Crash reporting"
              hint="panics and render errors only, scrubbed; no analytics, no usage telemetry, ever. Off by default."
            >
              <div
                className={`${styles.toggle} ${settings.crashReporting ? styles.toggleOn : ""}`}
                onClick={() => update({ crashReporting: !settings.crashReporting })}
                role="switch"
                aria-checked={settings.crashReporting}
              >
                {settings.crashReporting ? "on" : "off"}
              </div>
            </Row>

            {settings.crashReporting && (
              <Row
                label="Reporting endpoint"
                hint="Sentry or self-hosted GlitchTip ingestion URL; empty sends nothing"
              >
                <input
                  className={styles.text}
                  type="text"
                  value={settings.crashReportEndpoint}
                  onChange={(e) => update({ crashReportEndpoint: e.target.value })}
                  placeholder="https://…"
                />
              </Row>
            )}

            <Row
              label="Export diagnostics"
              hint="log tail, versions, settings and the last error, scrubbed — for a bug report"
            >
              <button className={styles.updateBtn} onClick={() => void exportDiagnostics()}>
                Export…
              </button>
            </Row>
          </Section>
        </div>

        <div className={styles.footer}>
          <span className={styles.note}>changes save automatically</span>
          <span className={styles.reset} onClick={() => setSettings(DEFAULT_SETTINGS)}>
            reset to defaults
          </span>
        </div>
      </div>
    </div>
  );
}

/** A labelled group of settings, with a heading in the body. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

/** One labelled setting with its control and an explanatory hint. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.labels}>
        <div className={styles.label}>{label}</div>
        <div className={styles.hint}>{hint}</div>
      </div>
      {children}
    </div>
  );
}
