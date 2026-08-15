/**
 * Error helpers for the B74-L typed error envelope. Backend command errors now
 * reject with an object `{ code, message, retryable, action: { label, hint },
 * detail? }` instead of a plain string; these helpers normalize any rejection
 * shape (envelope object, `Error`, string) so UI sites can't accidentally render
 * `[object Object]` — or leak the raw Rust/debug string as the primary message
 * (the raw text stays in `detail`, which is diagnostics-only).
 */

import type { ErrorEnvelope } from "../providers/types";

/** Is `e` the B74-L envelope object from the backend? */
export function isEnvelope(e: unknown): e is ErrorEnvelope {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    "action" in e
  );
}

/** The safe primary message for any rejection. */
export function errMsg(e: unknown): string {
  if (isEnvelope(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** The typed envelope, or null when the rejection isn't one. */
export function errEnvelope(e: unknown): ErrorEnvelope | null {
  return isEnvelope(e) ? e : null;
}

/**
 * The full primary display for a single error: the safe message *plus* the
 * specific next action, when the envelope knows one — "permission denied — the
 * current user can't do this; ask your cluster admin for the missing role."
 * (Raw `detail` is never included; that's diagnostics-only.)
 */
export function errDisplay(e: unknown): string {
  const env = errEnvelope(e);
  if (env) return env.action?.hint ? `${env.message} — ${env.action.hint}` : env.message;
  return errMsg(e);
}
