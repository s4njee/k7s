/**
 * Kubeconfig QR handoff (M9) — the same MK7S1 frames mk7s on a phone scans.
 *
 * k7s encodes the selected context as a cycling QR sequence. Wire format:
 *   header  MK7S1/<sid>/0/<n>/<sha256hex>/<b64url>
 *   data    MK7S1/<sid>/<i>/<n>/<b64url>
 * Frame 0 carries SHA-256 of the full UTF-8 kubeconfig so a missing/corrupt
 * frame cannot import on the phone.
 */

/** Raw bytes per data frame. Small enough to scan off a laptop from a phone. */
export const HANDOFF_CHUNK = 400;

const PREFIX = "MK7S1/";

export interface HandoffFrame {
  sid: string;
  idx: number;
  n: number;
  sha?: string;
  payload: Uint8Array;
}

export type HandoffEvent =
  | { status: "ignore" }
  | { status: "progress"; have: number; total: number }
  | { status: "complete"; text: string }
  | { status: "error"; reason: string };

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSid(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!s || /[^A-Za-z0-9_-]/.test(s)) return null;
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Parse one QR payload. Null if this is not an mk7s handoff frame. */
export function parseHandoffFrame(raw: string): HandoffFrame | null {
  const text = raw.trim();
  if (!text.startsWith(PREFIX)) return null;
  const parts = text.slice(PREFIX.length).split("/");
  if (parts.length < 4) return null;
  const [sid, idxS, nS, ...tail] = parts;
  if (!/^[0-9a-f]{8}$/.test(sid)) return null;
  const idx = Number(idxS);
  const n = Number(nS);
  if (!Number.isInteger(idx) || !Number.isInteger(n) || n < 1 || idx < 0 || idx >= n) {
    return null;
  }
  let sha: string | undefined;
  let payloadB64: string;
  if (idx === 0) {
    if (tail.length < 2) return null;
    sha = tail[0];
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    payloadB64 = tail.slice(1).join("/");
  } else {
    payloadB64 = tail.join("/");
  }
  const payload = b64urlDecode(payloadB64);
  if (!payload) return null;
  return { sid, idx, n, sha, payload };
}

/** Encode a kubeconfig (or any UTF-8 text) as a QR frame sequence. */
export async function encodeHandoff(
  text: string,
  opts?: { sid?: string; chunk?: number },
): Promise<string[]> {
  const bytes = new TextEncoder().encode(text);
  const sha = await sha256hex(bytes);
  const sid = opts?.sid ?? randomSid();
  const chunk = opts?.chunk ?? HANDOFF_CHUNK;
  const n = Math.max(1, Math.ceil(bytes.length / chunk) || 1);
  const frames: string[] = [];
  for (let i = 0; i < n; i++) {
    const slice = bytes.subarray(i * chunk, Math.min(bytes.length, (i + 1) * chunk));
    const payload = b64urlEncode(slice);
    frames.push(i === 0 ? `${PREFIX}${sid}/0/${n}/${sha}/${payload}` : `${PREFIX}${sid}/${i}/${n}/${payload}`);
  }
  return frames;
}

/**
 * Incremental assembler (same as the phone). Kept here so the wire format is
 * pinned by a round-trip test in this repo, not only in mk7s.
 */
export class HandoffAssembler {
  private sid: string | null = null;
  private n = 0;
  private sha = "";
  private chunks = new Map<number, Uint8Array>();

  reset(): void {
    this.sid = null;
    this.n = 0;
    this.sha = "";
    this.chunks.clear();
  }

  get have(): number {
    return this.chunks.size;
  }

  get total(): number {
    return this.n;
  }

  async add(raw: string): Promise<HandoffEvent> {
    const frame = parseHandoffFrame(raw);
    if (!frame) return { status: "ignore" };

    if (this.sid && frame.sid !== this.sid) this.reset();
    if (!this.sid) {
      this.sid = frame.sid;
      this.n = frame.n;
    } else if (frame.n !== this.n) {
      this.reset();
      return { status: "error", reason: "frame count changed — start the scan again" };
    }

    if (frame.sha) this.sha = frame.sha;
    this.chunks.set(frame.idx, frame.payload);

    if (this.chunks.size < this.n) {
      return { status: "progress", have: this.chunks.size, total: this.n };
    }
    for (let i = 0; i < this.n; i++) {
      if (!this.chunks.has(i)) {
        return { status: "progress", have: this.chunks.size, total: this.n };
      }
    }
    if (!this.sha) {
      this.reset();
      return { status: "error", reason: "missing header frame — keep scanning" };
    }

    let total = 0;
    for (let i = 0; i < this.n; i++) total += this.chunks.get(i)!.length;
    const all = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < this.n; i++) {
      const c = this.chunks.get(i)!;
      all.set(c, off);
      off += c.length;
    }
    const got = await sha256hex(all);
    if (got !== this.sha) {
      this.reset();
      return { status: "error", reason: "checksum mismatch — scan the sequence again" };
    }
    const text = new TextDecoder().decode(all);
    this.reset();
    return { status: "complete", text };
  }
}
