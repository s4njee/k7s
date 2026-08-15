/**
 * axe assertions for the B84 accessibility tests.
 *
 * Runs axe over the current document and fails on serious/critical violations.
 * jsdom cannot compute styles (CSS modules aren't loaded), so the contrast and
 * any layout-dependent rules are disabled — the structural rules axe is good at
 * in jsdom (landmark, list, button-name, aria-*, tabindex, nested-interactive,
 * label, …) are exactly where the B84 audit found the gaps. Page-shell rules
 * (document title, <html lang>) belong to the app shell, not to a view.
 */

import axe from "axe-core";

/** Rules that need a real browser or belong to the page shell, not a view. */
const DISABLED_RULES: Record<string, { enabled: false }> = {
  "color-contrast": { enabled: false },
  "color-contrast-enhanced": { enabled: false },
  "document-title": { enabled: false },
  "html-has-lang": { enabled: false },
  "region": { enabled: false },
};

/** Run axe; returns the serious/critical violations ([] is clean). */
export async function runAxe(): Promise<axe.Result[]> {
  const results = await axe.run(document, { rules: DISABLED_RULES });
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

/** Assert the current document has no serious/critical axe violations. */
export async function expectNoViolations(): Promise<void> {
  const violations = await runAxe();
  if (violations.length === 0) return;
  const detail = violations
    .map(
      (v) =>
        `- ${v.id} (${v.impact}): ${v.help}\n` +
        v.nodes.map((n) => `    ${n.target.join(" ")} — ${n.failureSummary?.replace(/\s+/g, " ")}`).join("\n"),
    )
    .join("\n");
  throw new Error(`axe serious/critical violations:\n${detail}`);
}
