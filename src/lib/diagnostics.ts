/**
 * Diagnostics (B73): the frontend half of "Export diagnostics…" and error
 * forwarding. Everything here is best-effort and silent — a failed export or
 * an unwritable log must never break the UI.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { IS_DEMO } from "../providers";
import { useStore } from "../store";
import { errEnvelope } from "./errors";

/** The last ErrorBoundary trace, kept for the diagnostics bundle. */
let lastBoundaryTrace: string | null = null;

/** The ErrorBoundary records its trace here; export reads it. */
export function recordBoundaryTrace(trace: string | null): void {
  lastBoundaryTrace = trace;
}

/**
 * Run the export: a native save dialog, then the backend zips the log tail,
 * versions, redacted settings and the last boundary trace. Silent on any
 * failure — the user can retry.
 */
export async function exportDiagnostics(): Promise<void> {
  if (IS_DEMO) return; // no Tauri backend to zip with
  try {
    const path = await save({
      title: "Export diagnostics",
      defaultPath: `k7s-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: "Diagnostics bundle", extensions: ["zip"] }],
    });
    if (!path) return; // cancelled

    const { context, clusterName } = useStore.getState().connection;
    await invoke("export_diagnostics", {
      path,
      context,
      cluster: clusterName,
      boundaryTrace: lastBoundaryTrace,
    });
  } catch {
    // Silent: the save dialog failing or the zip failing shouldn't surprise.
  }
}

/**
 * Forward a frontend error (window, unhandledrejection, or the React
 * ErrorBoundary) to the backend log — and to crash reporting when armed.
 */
export function logFrontendError(source: string, error: unknown): void {
  if (IS_DEMO) return; // browser page: nothing to forward to
  // B74-L: a command rejection is the typed envelope — its `detail` carries the
  // raw backend string, which is exactly what belongs in diagnostics (the UI
  // shows the safe `message`; the raw text goes to the log/export).
  const env = errEnvelope(error);
  const message = env
    ? env.detail ?? env.message
    : error instanceof Error
      ? error.message
      : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  void invoke("log_frontend_error", { source, message, stack }).catch(() => {});
}
