/**
 * Tests for settings sanitisation (B23). These values feed a ring buffer, two
 * poll loops and an exec command, so the point is that nothing hostile or
 * half-typed can reach them.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, LIMITS, sanitizeSettings } from "./settings";

describe("sanitizeSettings", () => {
  it("returns the defaults for nothing at all", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps values that are already fine", () => {
    const s = sanitizeSettings({
      logBufferCap: 1000,
      metricsIntervalSecs: 30,
      statusIntervalSecs: 20,
      defaultNamespace: "prod",
      shellCommand: "/bin/zsh",
    });
    expect(s.logBufferCap).toBe(1000);
    expect(s.metricsIntervalSecs).toBe(30);
    expect(s.defaultNamespace).toBe("prod");
    expect(s.shellCommand).toBe("/bin/zsh");
  });

  it("clamps a zero buffer, which would silently discard every log line", () => {
    expect(sanitizeSettings({ logBufferCap: 0 }).logBufferCap).toBe(LIMITS.logBufferCap.min);
  });

  it("clamps a buffer big enough to be a memory leak", () => {
    expect(sanitizeSettings({ logBufferCap: 10_000_000 }).logBufferCap).toBe(
      LIMITS.logBufferCap.max,
    );
  });

  it("refuses to hammer the API server with sub-second polling", () => {
    expect(sanitizeSettings({ metricsIntervalSecs: 0 }).metricsIntervalSecs).toBe(
      LIMITS.metricsIntervalSecs.min,
    );
    expect(sanitizeSettings({ statusIntervalSecs: -5 }).statusIntervalSecs).toBe(
      LIMITS.statusIntervalSecs.min,
    );
  });

  it("falls back to the default for a half-typed or empty number field", () => {
    // An emptied input yields NaN; the old value must not become NaN with it.
    expect(sanitizeSettings({ logBufferCap: NaN }).logBufferCap).toBe(
      DEFAULT_SETTINGS.logBufferCap,
    );
    expect(sanitizeSettings({ metricsIntervalSecs: Infinity }).metricsIntervalSecs).toBe(
      DEFAULT_SETTINGS.metricsIntervalSecs,
    );
  });

  it("rounds fractional input rather than passing it through", () => {
    expect(sanitizeSettings({ logBufferCap: 250.7 }).logBufferCap).toBe(251);
  });

  it("treats a blank namespace as no filter", () => {
    expect(sanitizeSettings({ defaultNamespace: "   " }).defaultNamespace).toBe("all");
    expect(sanitizeSettings({ defaultNamespace: "  prod " }).defaultNamespace).toBe("prod");
  });

  it("lets one bad field fall back without discarding the good ones", () => {
    const s = sanitizeSettings({ logBufferCap: -1, defaultNamespace: "prod" });
    expect(s.logBufferCap).toBe(LIMITS.logBufferCap.min);
    expect(s.defaultNamespace).toBe("prod");
  });

  it("ignores non-string junk in the text fields", () => {
    // Persisted prefs from an older build, or a hand-edited prefs.json.
    const s = sanitizeSettings({ shellCommand: 42 as unknown as string });
    expect(s.shellCommand).toBe("");
  });
});
