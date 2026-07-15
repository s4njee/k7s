/**
 * Unit tests for the display formatters. The expected values are taken directly
 * from the prototype's mock data (design/K8s Monitor.dc.html) so we know the real
 * UI will render identical strings in demo mode.
 */

import { describe, it, expect } from "vitest";
import { formatAge, formatCpu, formatMem } from "./format";

describe("formatAge", () => {
  // Fixed reference time so ages are deterministic.
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const ago = (secs: number) => new Date(now - secs * 1000).toISOString();

  it("shows seconds only under a minute (prototype: 38s)", () => {
    expect(formatAge(ago(38), now)).toBe("38s");
  });

  it("shows minutes with seconds in the first 10 minutes", () => {
    // 2h14m in the prototype is hours+minutes; here test the m+s branch.
    expect(formatAge(ago(2 * 60 + 14), now)).toBe("2m14s");
  });

  it("shows whole minutes past 10 minutes", () => {
    expect(formatAge(ago(23 * 60 + 5), now)).toBe("23m");
  });

  it("shows hours+minutes under a day (prototype: 2h14m)", () => {
    expect(formatAge(ago(2 * 3600 + 14 * 60), now)).toBe("2h14m");
  });

  it("shows days+hours in the first week (prototype: 4d2h)", () => {
    expect(formatAge(ago(4 * 86400 + 2 * 3600), now)).toBe("4d2h");
  });

  it("shows days only when large (prototype: 31d, 11d)", () => {
    expect(formatAge(ago(31 * 86400), now)).toBe("31d");
    expect(formatAge(ago(11 * 86400 + 5 * 3600), now)).toBe("11d");
  });

  it("clamps future timestamps to 0s", () => {
    expect(formatAge(ago(-500), now)).toBe("0s");
  });

  it("returns empty string for an unparseable timestamp", () => {
    expect(formatAge("not-a-date", now)).toBe("");
  });
});

describe("formatCpu", () => {
  it("renders millicores under 1000 (prototype: 212m, 45m, 8m)", () => {
    expect(formatCpu(212)).toBe("212m");
    expect(formatCpu(45)).toBe("45m");
    expect(formatCpu(8)).toBe("8m");
  });

  it("renders cores at/above 1000m", () => {
    expect(formatCpu(1000)).toBe("1");
    expect(formatCpu(1500)).toBe("1.5");
  });

  it("renders unknown/negative as em dash", () => {
    expect(formatCpu(-1)).toBe("—");
  });
});

describe("formatMem", () => {
  it("renders MiB under a GiB (prototype: 486Mi, 203Mi, 24Mi)", () => {
    expect(formatMem(486 * 1024 * 1024)).toBe("486Mi");
    expect(formatMem(203 * 1024 * 1024)).toBe("203Mi");
    expect(formatMem(24 * 1024 * 1024)).toBe("24Mi");
  });

  it("renders GiB with one decimal (prototype: 3.2Gi, 1.1Gi, 2.4Gi)", () => {
    expect(formatMem(Math.round(3.2 * 1024 * 1024 * 1024))).toBe("3.2Gi");
    expect(formatMem(Math.round(1.1 * 1024 * 1024 * 1024))).toBe("1.1Gi");
    expect(formatMem(Math.round(2.4 * 1024 * 1024 * 1024))).toBe("2.4Gi");
  });

  it("renders whole GiB without a decimal", () => {
    expect(formatMem(2 * 1024 * 1024 * 1024)).toBe("2Gi");
  });
});
