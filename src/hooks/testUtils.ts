/**
 * A minimal hook harness for tests.
 *
 * Just enough to mount a hook so its effects run — which is what tests of
 * document-level key handlers need, since the binding only exists once the effect
 * has. React Testing Library would do this and much more; this is ~20 lines and
 * one fewer dependency, and the "much more" (queries, user-event) is for testing
 * rendered markup, which these tests don't.
 */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// React refuses to run act() without this, and says so loudly.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

/** Mount a component that calls `hook`, running its effects. */
export function renderHook(hook: () => void): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const Harness = () => {
    hook();
    return null;
  };
  act(() => {
    root.render(createElement(Harness));
  });
  mounted.push({ root, container });
}

/** Mount a component and return its container, so tests can assert on markup. */
export function renderComponent(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

/** Unmount everything, so a hook's listeners don't leak into the next test. */
export function cleanup(): void {
  act(() => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted) container.remove();
  mounted.length = 0;
}
