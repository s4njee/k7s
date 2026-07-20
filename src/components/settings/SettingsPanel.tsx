/**
 * Settings panel (B23) — a modal over the app, opened by the sidebar's gear.
 *
 * Every change is applied and persisted immediately: there's no Save button,
 * because there's nothing here worth a confirmation step and a Cancel would imply
 * a rollback we don't implement. Values are sanitised on the way in (see
 * lib/settings.ts), so a half-typed field can't reach a ring buffer or a poll loop.
 *
 * Settings that can't take effect until the next connect say so, rather than
 * quietly doing nothing.
 */

import { useEffect } from "react";
import styles from "./SettingsPanel.module.css";
import { useStore } from "../../store";
import { LIMITS, DEFAULT_SETTINGS, sanitizeSettings, type Settings } from "../../lib/settings";
import { asTheme } from "../../lib/theme";

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const connected = useStore((s) => s.connection.phase === "connected");

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
          {/* First, because it's the one setting whose effect you see while the
              panel is still open. */}
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
