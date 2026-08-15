/**
 * Port-forward management workspace (B89): a searchable modal over this cluster's
 * active forwards and saved presets — open in browser, stop/start, edit-local-port
 * (stop + restart with the chosen port), delete, and save-as-preset. Presets are
 * disabled while the cluster is offline (phase != connected OR stale), and do not
 * auto-connect on launch unless their `autoRestart` flag opts in.
 *
 * The compact ForwardsBar stays the always-visible active-session summary; this
 * is the full management surface.
 */

import { useMemo, useRef, useState } from "react";
import styles from "./ForwardManager.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { openExternal } from "../../lib/openExternal";
import { viewId } from "../../lib/views";
import { errDisplay } from "../../lib/errors";
import type { ForwardInfo, ForwardPreset } from "../../providers/types";

export function ForwardManager() {
  const open = useStore((s) => s.forwardManagerOpen);
  const setOpen = useStore((s) => s.setForwardManagerOpen);
  const cid = useStore((s) => s.activeCid);
  const connection = useStore((s) => s.connection);
  const clusterStatus = useStore((s) => s.clusterStatus);
  const forwards = useStore((s) => s.portForwards);
  const presets = useStore((s) => (s.activeCid ? s.forwardPresetsByCid[s.activeCid] ?? [] : []));
  const addPreset = useStore((s) => s.addForwardPreset);
  const removePreset = useStore((s) => s.removeForwardPreset);
  const setPortForwards = useStore((s) => s.setPortForwards);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ kind: "pods" | "services"; target: string; remotePort: number; localPort: string; name: string }>({
    kind: "services",
    target: "",
    remotePort: 8080,
    localPort: "",
    name: "",
  });
  const [editPort, setEditPort] = useState<{ kind: "forward" | "preset"; id: string; localPort: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // Presets need a live cluster: disconnected or stale → disabled.
  const online = connection.phase === "connected" && !clusterStatus?.stale;

  const refresh = async () => {
    if (!cid) return;
    setPortForwards(cid, await getProvider().listPortForwards());
  };

  const q = query.trim().toLowerCase();
  const visibleForwards = useMemo(
    () => forwards.filter((f) => !q || `${f.localPort} ${f.service ?? ""} ${f.pod}`.toLowerCase().includes(q)),
    [forwards, q],
  );
  const visiblePresets = useMemo(
    () => presets.filter((p) => !q || `${p.name} ${p.target} ${p.namespace}`.toLowerCase().includes(q)),
    [presets, q],
  );

  const startPreset = async (p: ForwardPreset) => {
    if (!cid || !online) return;
    setError(null);
    try {
      await getProvider().startPortForward(
        { kind: p.kind, namespace: p.namespace, name: p.target },
        p.remotePort,
        p.localPort,
      );
      await refresh();
    } catch (e) {
      setError(errDisplay(e));
    }
  };

  const stop = async (id: string) => {
    await getProvider().stopPortForward(id);
    await refresh();
  };

  const editForwardPort = async (f: ForwardInfo) => {
    if (!editPort || editPort.kind !== "forward") return;
    const port = Number(editPort.localPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    setError(null);
    try {
      await getProvider().stopPortForward(f.id);
      // Restart with the chosen local port; a Service re-resolves its backing pod.
      await getProvider().startPortForward(
        { kind: f.service ? "services" : "pods", namespace: f.namespace, name: f.service ?? f.pod },
        f.servicePort ?? f.remotePort,
        port,
      );
      await refresh();
      setEditPort(null);
    } catch (e) {
      setError(errDisplay(e));
    }
  };

  const saveAsPreset = (f: ForwardInfo) => {
    if (!cid) return;
    const name = `${f.service ?? f.pod}:${f.servicePort ?? f.remotePort}`;
    addPreset(cid, {
      id: viewId(name),
      name,
      kind: f.service ? "services" : "pods",
      namespace: f.namespace,
      target: f.service ?? f.pod,
      remotePort: f.servicePort ?? f.remotePort,
      localPort: f.localPort,
    });
  };

  const createPreset = async () => {
    if (!cid || !form.target.trim() || !form.name.trim()) return;
    const localPort = form.localPort.trim() ? Number(form.localPort) : undefined;
    const preset: ForwardPreset = {
      id: viewId(form.name),
      name: form.name.trim(),
      kind: form.kind,
      namespace: "default",
      target: form.target.trim(),
      remotePort: form.remotePort,
      ...(localPort ? { localPort } : {}),
    };
    addPreset(cid, preset);
    setCreating(false);
    setForm({ kind: "services", target: "", remotePort: 8080, localPort: "", name: "" });
  };

  const toggleAutoRestart = (p: ForwardPreset) => {
    if (!cid) return;
    addPreset(cid, { ...p, autoRestart: !p.autoRestart });
  };

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="port forwards">
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} ref={dialogRef}>
        <div className={styles.header}>
          <span className={styles.title}>Port forwards</span>
          <span className={styles.subtitle}>for {cid}</span>
          <button type="button" className={styles.close} aria-label="close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <input
          className={styles.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter forwards and presets…"
          aria-label="filter forwards and presets"
        />

        {!online && (
          <div className={styles.offline}>cluster offline — presets disabled</div>
        )}
        {error && <div className={styles.error} role="alert">{error}</div>}

        <div className={styles.sectionTitle}>Active</div>
        {visibleForwards.length === 0 ? (
          <div className={styles.empty}>no active forwards</div>
        ) : (
          visibleForwards.map((f) => (
            <div key={f.id} className={`${styles.row} ${f.error ? styles.rowError : ""}`}>
              <span className={styles.local} title={f.error}>
                localhost:{f.localPort}
              </span>
              <span className={styles.arrow} aria-hidden="true">→</span>
              <span className={styles.target}>
                {f.service ?? f.pod}:{f.servicePort ?? f.remotePort}
              </span>
              {f.error && <span className={styles.rowErrorText}>{f.error}</span>}
              {editPort?.kind === "forward" && editPort.id === f.id ? (
                <span className={styles.editRow}>
                  <input
                    className={styles.portInput}
                    value={editPort.localPort}
                    onChange={(e) => setEditPort({ ...editPort, localPort: e.target.value })}
                    aria-label="new local port"
                  />
                  <button type="button" className={styles.btn} onClick={() => void editForwardPort(f)}>Save</button>
                  <button type="button" className={styles.btn} onClick={() => setEditPort(null)}>Cancel</button>
                </span>
              ) : (
                <span className={styles.actions}>
                  <button type="button" className={styles.btn} title="open in browser" aria-label={`open localhost:${f.localPort}`} onClick={() => void openExternal(`http://localhost:${f.localPort}`)}>↗</button>
                  <button type="button" className={styles.btn} aria-label="edit active forward's local port" onClick={() => setEditPort({ kind: "forward", id: f.id, localPort: String(f.localPort) })}>edit</button>
                  <button type="button" className={styles.btn} aria-label="save as preset" onClick={() => saveAsPreset(f)}>preset</button>
                  <button type="button" className={styles.btn} aria-label="stop forward" onClick={() => void stop(f.id)}>✕</button>
                </span>
              )}
            </div>
          ))
        )}

        <div className={styles.sectionTitle}>Presets</div>
        {creating ? (
          <div className={styles.createForm}>
            <select className={styles.portInput} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "pods" | "services" })} aria-label="preset kind">
              <option value="services">service</option>
              <option value="pods">pod</option>
            </select>
            <input className={styles.portInput} value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="service/pod name" aria-label="service or pod name" />
            <input className={styles.portInput} type="number" value={form.remotePort} onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })} aria-label="remote port" />
            <input className={styles.portInput} type="number" value={form.localPort} onChange={(e) => setForm({ ...form, localPort: e.target.value })} placeholder="local port (optional)" aria-label="local port" />
            <input className={styles.portInput} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="preset name" aria-label="preset name" />
            <span className={styles.editRow}>
              <button type="button" className={styles.btn} onClick={() => void createPreset()}>Save</button>
              <button type="button" className={styles.btn} onClick={() => setCreating(false)}>Cancel</button>
            </span>
          </div>
        ) : (
          <button type="button" className={styles.addBtn} onClick={() => setCreating(true)}>
            + new preset
          </button>
        )}

        {visiblePresets.length === 0 ? (
          <div className={styles.empty}>no presets saved</div>
        ) : (
          visiblePresets.map((p) => (
            <div key={p.id} className={styles.row}>
              <span className={styles.presetName}>{p.name}</span>
              <span className={styles.target}>
                {p.kind === "services" ? "svc" : "pod"} {p.target}:{p.remotePort}
                {p.localPort ? ` → :${p.localPort}` : ""}
              </span>
              <span className={styles.actions}>
                <button type="button" className={styles.btn} disabled={!online} aria-label={`start ${p.name}`} onClick={() => void startPreset(p)}>start</button>
                <button type="button" className={styles.btn} disabled={!online} aria-label={`edit local port of ${p.name}`} onClick={() => setEditPort({ kind: "preset", id: p.id, localPort: String(p.localPort ?? "") })}>edit</button>
                <button type="button" className={`${styles.btn} ${p.autoRestart ? styles.on : ""}`} aria-pressed={!!p.autoRestart} onClick={() => toggleAutoRestart(p)} title="restart after the cluster comes back">auto</button>
                <button type="button" className={styles.btn} aria-label={`delete preset ${p.name}`} onClick={() => cid && removePreset(cid, p.id)}>✕</button>
              </span>
              {editPort?.kind === "preset" && editPort.id === p.id && (
                <span className={styles.editRow}>
                  <input className={styles.portInput} value={editPort.localPort} onChange={(e) => setEditPort({ ...editPort, localPort: e.target.value })} aria-label="new local port" />
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => {
                      const port = Number(editPort.localPort);
                      if (cid && Number.isInteger(port) && port >= 1 && port <= 65535) {
                        addPreset(cid, { ...p, localPort: port });
                        setEditPort(null);
                      }
                    }}
                  >
                    Save
                  </button>
                  <button type="button" className={styles.btn} onClick={() => setEditPort(null)}>Cancel</button>
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
