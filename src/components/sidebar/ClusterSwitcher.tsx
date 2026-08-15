/**
 * Cluster switcher (Design §1, top of the sidebar): a compact *rail* of connected
 * clusters — initial + colour, connection dot, worst-problem tint — plus the
 * active cluster's identity and a dropdown of every kubeconfig context. Clicking
 * a rail chip switches instantly (the store retains each cluster's data, B77);
 * the dropdown connects a not-yet-connected context.
 */

import { useRef, useState } from "react";
import styles from "./Sidebar.module.css";
import { useStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import { connectTo } from "../../lib/connect";
import { getProvider } from "../../providers";
import { deriveProblems } from "../../lib/problems";
import { emptyRows } from "../../store/dataSlice";
import { ShowKubeconfigQr } from "./ShowKubeconfigQr";

/** First two letters of the cluster name, uppercased ("FR" for "freya"). */
function initials(name: string): string {
  return name.slice(0, 2).toUpperCase() || "K7";
}

/** Rail palette (the app's accent hues), for the per-cluster colour default. */
const RAIL_COLORS = ["#4d9fff", "#34b37c", "#b18cff", "#ff9d4d", "#f7768e", "#e0af68"];

/** Deterministic default colour for a cid that has no user-set one (shared with
 *  the terminal tabs, so a cluster reads the same everywhere, B82). */
export function railColor(cid: string, colors: Record<string, string>): string {
  if (colors[cid]) return colors[cid];
  let h = 0;
  for (const ch of cid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return RAIL_COLORS[h % RAIL_COLORS.length];
}

export function ClusterSwitcher() {
  const connection = useStore((s) => s.connection);
  const clusterStatus = useStore((s) => s.clusterStatus);
  const clusterStatusByCid = useStore((s) => s.clusterStatusByCid);
  const activeCid = useStore((s) => s.activeCid);
  const connections = useStore((s) => s.connections);
  const rowsByCid = useStore((s) => s.rowsByCid);
  const clusterColors = useStore((s) => s.clusterColors);
  const setActiveCid = useStore((s) => s.setActiveCid);
  const contexts = useStore((s) => s.contexts);
  const open = useStore((s) => s.openMenu === "cluster");
  const toggleMenu = useStore((s) => s.toggleMenu);
  const closeMenus = useStore((s) => s.closeMenus);
  const setContexts = useStore((s) => s.setContexts);
  const addImportedFile = useStore((s) => s.addImportedFile);

  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, closeMenus, open);
  const [qrContext, setQrContext] = useState<string | null>(null);

  // Import contexts from a kubeconfig file (native picker), then merge them into
  // the switcher list. A null result means the user cancelled the dialog.
  const onImport = async () => {
    closeMenus();
    const result = await getProvider().importKubeconfig();
    if (!result) return;
    setContexts(result.contexts);
    // Remember the file so its contexts come back on the next launch (B17).
    addImportedFile(result.path);
  };

  // Display name: the connected cluster, else the selected context, else a stub.
  const name = connection.clusterName ?? connection.context ?? "no cluster";

  // Status line: dot color + text reflect the connection lifecycle (B74-L: a
  // stale cluster shows amber "stale", not green "connected").
  const { dotColor, statusText } = statusDisplay(
    connection.phase,
    clusterStatus?.stale ?? false,
    clusterStatus?.version,
  );

  // The rail: every connected cluster, each with its worst-problem tint.
  const rail = Object.keys(connections).map((cid) => {
    const conn = connections[cid];
    const problems = deriveProblems(rowsByCid[cid] ?? emptyRows());
    // Problem rows carry their severity in the first cell's tone (see severity()).
    const worst = problems.some((p) => p.cells[0]?.tone === "err")
      ? "err"
      : problems.length
        ? "warn"
        : null;
    // B74-L: a connected-but-stale cluster reads amber, not green — its rows are
    // retained, but the API isn't answering.
    const stale = clusterStatusByCid[cid]?.stale ?? false;
    const dot =
      stale
        ? "var(--status-warn)"
        : conn.phase === "connected"
          ? "var(--status-ok)"
          : conn.phase === "connecting"
            ? "var(--status-warn)"
            : "var(--status-err)";
    return {
      cid,
      dot,
      color: railColor(cid, clusterColors),
      worst,
      isActive: cid === activeCid,
    };
  });

  return (
    <div className={styles.switcher} ref={ref}>
      {/* Rail of connected clusters (B77). Click switches instantly. */}
      {rail.length > 1 && (
        <div className={styles.rail}>
          {rail.map((r) => (
            <button
              key={r.cid}
              className={`${styles.railChip} ${r.isActive ? styles.railChipActive : ""} ${
                r.worst ? styles.railChipProblem : ""
              }`}
              title={r.cid}
              onClick={() => {
                if (!r.isActive) setActiveCid(r.cid);
              }}
            >
              <span
                className={styles.railDot}
                style={{ background: r.dot, color: r.color }}
              />
              <span className={styles.railInitials} style={{ background: r.color }}>
                {initials(r.cid)}
              </span>
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className={styles.switcherButton}
        onClick={() => toggleMenu("cluster")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className={styles.badge}>{initials(name)}</div>
        <div className={styles.switcherText}>
          <div className={styles.clusterName}>{name}</div>
          <div className={styles.statusLine}>
            <span className={styles.dot} style={{ background: dotColor }} aria-hidden="true" />
            {statusText}
          </div>
        </div>
        <span className={styles.chevron} aria-hidden="true">▼</span>
      </button>

      {open && (
        <div className={styles.menu} role="listbox" aria-label="kubeconfig contexts">
          {contexts.map((ctx) => {
            const isCurrent = ctx.name === connection.context;
            return (
              <div
                key={ctx.name}
                className={`${styles.menuRow} ${isCurrent ? styles.menuRowActive : ""}`}
              >
                {/* A button cannot nest a button, so the connect action and the QR
                    action are sibling buttons in a shared flex row (B84). */}
                <button
                  type="button"
                  className={styles.menuRowMain}
                  onClick={() => {
                    closeMenus();
                    // No-op if re-selecting the already-connected context.
                    if (!isCurrent) void connectTo(ctx.name);
                  }}
                  aria-current={isCurrent ? "true" : undefined}
                >
                  <span
                    className={styles.dot}
                    style={{ background: isCurrent ? "var(--status-ok)" : "var(--dot-inactive)" }}
                    aria-hidden="true"
                  />
                  <span className={styles.menuName}>{ctx.name}</span>
                  <span className={styles.menuEnv}>{ctx.cluster}</span>
                </button>
                <button
                  type="button"
                  className={styles.qrBtn}
                  title="Show as QR for mk7s on a phone"
                  aria-label={`show ${ctx.name} as a QR code`}
                  onClick={() => {
                    closeMenus();
                    setQrContext(ctx.name);
                  }}
                >
                  ▣
                </button>
              </div>
            );
          })}
          {contexts.length === 0 && (
            <div className={styles.menuRow}>
              <span className={styles.menuName} style={{ color: "var(--text-faint)" }}>
                no contexts
              </span>
            </div>
          )}

          {/* Import action, separated from the context list. */}
          <div className={styles.menuDivider} />
          <button type="button" className={styles.menuRow} onClick={() => void onImport()}>
            <span className={styles.importIcon} aria-hidden="true">＋</span>
            <span className={styles.menuName}>Import kubeconfig…</span>
          </button>
        </div>
      )}

      {qrContext && <ShowKubeconfigQr context={qrContext} onClose={() => setQrContext(null)} />}
    </div>
  );
}

/** Map connection phase (+ staleness) → status dot color + text. */
function statusDisplay(
  phase: "idle" | "connecting" | "connected" | "error",
  stale: boolean,
  version?: string,
): { dotColor: string; statusText: string } {
  if (stale && phase === "connected") {
    // B74-L: connected but the API isn't answering — retained rows, stale age.
    return { dotColor: "var(--status-warn)", statusText: "stale · showing last data" };
  }
  switch (phase) {
    case "connected":
      return {
        dotColor: "var(--status-ok)",
        statusText: `connected · ${version ?? ""}`.trim(),
      };
    case "connecting":
      return { dotColor: "var(--status-warn)", statusText: "connecting…" };
    default:
      return { dotColor: "var(--status-err)", statusText: "disconnected" };
  }
}
