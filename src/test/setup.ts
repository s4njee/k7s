/**
 * Shared vitest setup for frontend tests (B83).
 *
 * Registers jest-dom matchers for React Testing Library and stubs the browser
 * APIs components depend on that jsdom doesn't implement. The virtual-table and
 * terminal components touch `ResizeObserver` / `matchMedia`; a missing stub
 * fails the test with "not implemented", which is noise, not signal.
 */

import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia; components that branch on it (e.g.
// compact table layouts, the cluster rail) need a minimal real one.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// The virtualized table measures viewport rows through ResizeObserver. A no-op
// stub is enough: jsdom has no layout, and the table falls back to its
// non-virtual path, which is exactly what the component tests want to drive.
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
