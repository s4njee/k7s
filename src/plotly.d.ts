/**
 * Minimal types for plotly.js-basic-dist-min (B27).
 *
 * The dist bundles ship no declarations, and `@types/plotly.js` types the *full*
 * library — a large surface describing chart types this bundle doesn't contain,
 * which would let code compile against traces that don't exist at runtime.
 * Declaring the two calls we actually make is smaller and can't lie.
 */
declare module "plotly.js-basic-dist-min" {
  /** Draw or update a plot, diffing against what's already rendered. */
  export function react(
    root: HTMLElement,
    data: unknown[],
    layout?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<void>;

  /** Tear a plot down, releasing its listeners. */
  export function purge(root: HTMLElement): void;

  const Plotly: {
    react: typeof react;
    purge: typeof purge;
  };
  export default Plotly;
}
