/**
 * CSV export (B87): RFC 4180 quoting, and the acceptance case — a 10k-row
 * filtered table exports exactly the logical result in current order, with no
 * hidden columns.
 */

import { describe, expect, it } from "vitest";
import { buildCsv } from "./csv";
import type { Cell } from "../providers/types";

const cell = (text: string, tone: "primary" | "secondary" | "ok" | "warn" | "err" | "muted" = "secondary"): Cell => ({ text, tone });

describe("buildCsv quoting", () => {
  it("leaves plain fields unquoted", () => {
    expect(buildCsv(["A", "B"], [[cell("x"), cell("y")]])).toBe("A,B\nx,y\n");
  });

  it("quotes a field containing a comma", () => {
    expect(buildCsv(["A"], [[cell("hello, world")]])).toBe('A\n"hello, world"\n');
  });

  it("doubles interior quotes and wraps fields with quotes or newlines", () => {
    expect(buildCsv(["A"], [[cell('say "hi"')]])).toBe('A\n"say ""hi"""\n');
    expect(buildCsv(["A"], [[cell("line1\nline2")]])).toBe('A\n"line1\nline2"\n');
  });

  it("keeps an empty field bare between commas", () => {
    const out = buildCsv(["A", "B"], [[cell(""), cell("plain")]]);
    expect(out).toBe("A,B\n,plain\n");
  });
});

describe("buildCsv — the 10k-row acceptance", () => {
  it("exports exactly the logical result in order, no hidden columns", () => {
    const headers = ["NAME", "STATUS", "CPU"];
    const rows: Cell[][] = [];
    for (let i = 0; i < 10_000; i++) {
      rows.push([cell(`pod-${i}`), cell(i % 3 === 0 ? "CrashLoopBackOff" : "Running"), cell(`${i}m`)]);
    }
    const csv = buildCsv(headers, rows);

    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(headers.join(","));
    expect(lines).toHaveLength(10_001); // the header + 10k data rows
    expect(lines[1]).toBe("pod-0,CrashLoopBackOff,0m");
    expect(lines[5000]).toBe("pod-4999,Running,4999m");
    expect(lines[10000]).toBe("pod-9999,CrashLoopBackOff,9999m"); // 9999 % 3 === 0
    // A hostile value survives as a quoted field, not extra columns.
    const hostile = buildCsv(["A", "B"], [[cell('pod,"quoted"'), cell("Running")]]);
    expect(hostile).toBe('A,B\n"pod,""quoted""",Running\n');
  });
});
