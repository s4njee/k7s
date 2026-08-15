/**
 * The restricted JSONPath subset both the backend and the frontend use (B30),
 * shared by CRD printer columns, local custom columns (B87), and later B85
 * extensions.
 *
 * Mirrors `src-tauri/src/kube/jsonpath.rs` exactly: dotted field access plus
 * `[n]` numeric array indexing, with the braced `{.a.b}` and leading `$` forms
 * tolerated. Anything else (`[*]`, `[?(...)]`, slices, quoted keys) is
 * unsupported and resolves to nothing — the same "—" contract as the backend.
 */

import type { Cell } from "../providers/types";

/** Evaluate a path; undefined for an unresolvable path, a subtree, or null. */
export function evalJsonPath(path: string, obj: unknown): unknown {
  const segs = parseJsonPath(path);
  if (!segs) return undefined;
  let cur: unknown = obj;
  for (const seg of segs) {
    if (typeof seg === "number") {
      cur = Array.isArray(cur) ? cur[seg] : undefined;
    } else {
      cur = (cur as Record<string, unknown> | undefined)?.[seg];
    }
    if (cur === undefined || cur === null) return undefined;
  }
  return typeof cur === "object" ? undefined : cur;
}

/** Tokenize a kubectl-style path (`.a.b[0].c`, `{.a.b}`, `$.a.b`) into
 * field/index segments, or null for syntax the subset doesn't cover. */
export function parseJsonPath(path: string): (string | number)[] | null {
  let s = path.trim();
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
  if (s.startsWith("$")) s = s.slice(1);
  const segs: (string | number)[] = [];
  let field = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") {
      if (field) {
        segs.push(field);
        field = "";
      }
      i++;
    } else if (ch === "[") {
      if (field) {
        segs.push(field);
        field = "";
      }
      i++;
      const start = i;
      while (i < s.length && /\d/.test(s[i])) i++;
      if (i === start || i >= s.length || s[i] !== "]") return null;
      segs.push(Number(s.slice(start, i)));
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field) segs.push(field);
  return segs;
}

/**
 * Evaluate a path to a Cell: a scalar value as secondary text, anything else
 * (missing, a subtree, unsupported syntax) as "—". The generic form of the
 * printer-column contract, without the printer-specific date handling.
 */
export function jsonpathCell(path: string, obj: unknown): Cell {
  const v = evalJsonPath(path, obj);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return { text: String(v), tone: "secondary" };
  }
  return { text: "—", tone: "secondary" };
}
