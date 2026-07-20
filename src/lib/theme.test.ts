import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  asTheme,
  buildTheme,
  PLOT_TOKENS,
  resolveTheme,
  TERM_TOKENS,
  withAlpha,
} from "./theme";

describe("resolveTheme", () => {
  it("takes an explicit choice regardless of the OS", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("follows the OS only for 'system'", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("asTheme", () => {
  it("passes through the three valid values", () => {
    expect(asTheme("dark")).toBe("dark");
    expect(asTheme("light")).toBe("light");
    expect(asTheme("system")).toBe("system");
  });

  /**
   * Prefs are JSON on disk and hand-editable, and older versions had no theme
   * key at all. Anything unrecognised must land on the default rather than
   * reaching the DOM as a bogus data-theme value.
   */
  it("defaults anything else to 'system'", () => {
    for (const junk of [null, undefined, "", "Dark", "solarized", 3, {}]) {
      expect(asTheme(junk)).toBe("system");
    }
  });
});

describe("buildTheme", () => {
  it("maps every slot through the lookup", () => {
    const out = buildTheme({ a: "--x", b: "--y" }, (n) => (n === "--x" ? "#111" : "#222"));
    expect(out).toEqual({ a: "#111", b: "#222" });
  });

  it("trims what getComputedStyle returns", () => {
    // getPropertyValue keeps the leading space from `--x: #111`.
    expect(buildTheme({ a: "--x" }, () => "  #111 ")).toEqual({ a: "#111" });
  });

  /**
   * An unresolvable token would otherwise hand xterm an empty string, which it
   * renders as black — invisible on a dark background, and impossible to
   * diagnose from the UI. A wrong-but-legible colour is the better failure.
   */
  it("falls back to a real colour when a token resolves to nothing", () => {
    const out = buildTheme({ bg: "--bg-terminal" }, () => "");
    expect(out.bg).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("withAlpha", () => {
  it("converts 6-digit hex to rgba", () => {
    expect(withAlpha("#4d9fff", 0.12)).toBe("rgba(77,159,255,0.12)");
  });

  it("expands 3-digit hex", () => {
    expect(withAlpha("#abc", 0.5)).toBe("rgba(170,187,204,0.5)");
  });

  it("tolerates the whitespace getPropertyValue leaves behind", () => {
    expect(withAlpha("  #000000 ", 1)).toBe("rgba(0,0,0,1)");
  });

  /**
   * Passing an unrecognised format through unchanged beats mangling it: plotly
   * will at least render *something*, and a token that isn't hex is a tokens.css
   * problem to fix there rather than to paper over here.
   */
  it("passes through anything that isn't plain hex", () => {
    expect(withAlpha("rgba(1,2,3,0.5)", 0.2)).toBe("rgba(1,2,3,0.5)");
    expect(withAlpha("", 0.2)).toBe("");
  });
});

// ---- the palettes themselves ----

// Read from disk rather than imported: vitest stubs CSS imports to an empty
// string, so even `?raw` yields nothing. Path is relative to the repo root, which
// is vitest's cwd. See src/types/node-test-apis.d.ts for why there are no full
// Node types.
const CSS = readFileSync(resolve("src/styles/tokens.css"), "utf8");

/**
 * Custom properties declared inside one CSS block.
 *
 * Anchored to the opening brace rather than found by plain substring search: the
 * file's own header comment names both selectors, and matching that comment
 * silently parsed the `:root` block twice — making the two palettes compare equal
 * and every check below vacuously pass.
 */
function tokensIn(selector: string): Map<string, string> {
  const open = new RegExp(`${selector.replace(/[[\]"]/g, "\\$&")}\\s*\\{`);
  const m = open.exec(CSS);
  expect(m, `${selector} block missing from tokens.css`).not.toBeNull();
  const start = m!.index + m![0].length;
  const body = CSS.slice(start, CSS.indexOf("}", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/**
 * These read tokens.css as data rather than through a browser, because the bug
 * they're guarding is a *missing* declaration — which renders as "silently keeps
 * the dark value" and looks fine in every unit test that only exercises the
 * default palette.
 */
describe("tokens.css palettes", () => {
  const dark = tokensIn(":root");
  const light = tokensIn('[data-theme="light"]');

  it("defines a usable number of tokens", () => {
    expect(dark.size).toBeGreaterThan(40);
  });

  /**
   * The whole light theme rests on this. A colour token present only in :root
   * keeps its dark value under [data-theme="light"] — so a forgotten line shows
   * up as one unreadable widget on a white page, not as an error.
   */
  it("redefines every dark colour token in the light palette", () => {
    const missing = [...dark.keys()].filter(
      // Fonts and geometry are shared on purpose; only colours need a second value.
      (k) => !light.has(k) && !/^--(font|radius)-/.test(k),
    );
    expect(missing).toEqual([]);
  });

  it("adds nothing to the light palette that dark lacks", () => {
    expect([...light.keys()].filter((k) => !dark.has(k))).toEqual([]);
  });

  /** A copy-paste that left a dark value behind would defeat the point. */
  it("gives the two palettes genuinely different values", () => {
    const same = [...light].filter(([k, v]) => dark.get(k) === v);
    expect(same).toEqual([]);
  });

  /** The JS bridge can only resolve tokens that actually exist. */
  it("defines every token the terminal and plots ask for, in both palettes", () => {
    for (const name of [...Object.values(TERM_TOKENS), ...Object.values(PLOT_TOKENS)]) {
      expect(dark.has(name), `${name} missing from :root`).toBe(true);
      expect(light.has(name), `${name} missing from the light palette`).toBe(true);
    }
  });

  /**
   * Light mode keeps a white work area but dark side panels (sidebar + detail).
   * Those panels redefine tokens under [data-surface="panel"]; a missing block
   * would leave the inspector light-grey on white again.
   */
  it("defines a dark panel surface for light mode", () => {
    const panel = tokensIn('[data-theme="light"] [data-surface="panel"]');
    expect(panel.get("--bg-panel")).toMatch(/^#[0-3]/);
    expect(panel.get("--bg-chrome")).toMatch(/^#[0-3]/);
    expect(panel.get("--text-primary")).toMatch(/^#[d-f]/i);
    // Every light colour token must be re-set, or light text/bg leaks into the panel.
    const missing = [...light.keys()].filter((k) => !panel.has(k));
    expect(missing).toEqual([]);
  });
});
