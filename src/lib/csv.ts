/**
 * CSV building for the table export (B87): the current logical result (the
 * filtered/sorted rows) rendered through the visible columns — never the mounted
 * virtual slice. RFC 4180 quoting: a field containing a comma, quote, or newline
 * is wrapped in quotes with interior quotes doubled; LF line endings.
 */

import type { Cell } from "../providers/types";

function escapeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build a CSV document from a header row and cell rows (all visible columns). */
export function buildCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(row.map((c) => escapeField(c.text)).join(","));
  }
  return lines.join("\n") + "\n";
}
