/**
 * Tests for the appearance preferences (font / accent / reduced motion): the
 * narrowers that keep persisted junk off the DOM, and the apply functions that
 * put the attributes on <html> where tokens.css and global.css react to them.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCENTS,
  applyAccent,
  applyReducedMotion,
  applyUiFont,
  asAccent,
  asUiFont,
  UI_FONTS,
} from "./appearance";

describe("asUiFont / asAccent", () => {
  it("passes through the valid values", () => {
    for (const f of UI_FONTS) expect(asUiFont(f)).toBe(f);
    for (const a of ACCENTS) expect(asAccent(a)).toBe(a);
  });

  /**
   * Prefs are JSON on disk and hand-editable, and older versions had no font or
   * accent keys at all. Anything unrecognised must land on the design default
   * (mono / blue) rather than reaching the DOM as a bogus data-* value.
   */
  it("defaults anything else to the design values", () => {
    for (const junk of [null, undefined, "", "Helvetica", "solarized", 3, {}]) {
      expect(asUiFont(junk)).toBe("mono");
      expect(asAccent(junk)).toBe("blue");
    }
  });
});

describe("apply functions", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.uiFont;
    delete document.documentElement.dataset.accent;
    delete document.documentElement.dataset.reducedMotion;
  });

  it("sets the UI font attribute", () => {
    applyUiFont("sans");
    expect(document.documentElement.dataset.uiFont).toBe("sans");
    applyUiFont("mono");
    expect(document.documentElement.dataset.uiFont).toBe("mono");
  });

  it("sets the accent attribute", () => {
    applyAccent("green");
    expect(document.documentElement.dataset.accent).toBe("green");
    applyAccent("blue");
    expect(document.documentElement.dataset.accent).toBe("blue");
  });

  it("sets and removes the reduced-motion attribute (presence is the state)", () => {
    applyReducedMotion(true);
    expect(document.documentElement.dataset.reducedMotion).toBe("true");
    applyReducedMotion(false);
    expect(document.documentElement.dataset.reducedMotion).toBeUndefined();
  });
});
