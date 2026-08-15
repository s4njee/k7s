/**
 * B84 acceptance: axe reports zero serious/critical issues on every main view in
 * both themes. Each view renders against the live demo store (B83 bootstrap), the
 * theme is applied via `applyTheme` (which sets <html data-theme>), and axe runs
 * over the rendered DOM. jsdom can't compute styles, so contrast is excluded (see
 * src/test/axe.ts) — these tests pin the structural/ARIA rules the audit found
 * the gaps in.
 */

import { afterAll, beforeEach, describe, it } from "vitest";
import { render } from "@testing-library/react";
import { ClusterOverview } from "./components/overview/ClusterOverview";
import { ResourceTable } from "./components/table/ResourceTable";
import { ClusterSwitcher } from "./components/sidebar/ClusterSwitcher";
import { DetailPanel } from "./components/detail/DetailPanel";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { useStore } from "./store";
import { applyTheme } from "./lib/theme";
import { connectAll, resetStore, subscribeProvider } from "./test/bootstrap";
import { expectNoViolations } from "./test/axe";

vi.mock("./components/terminal/KubectlTerminal", () => ({
  KubectlTerminal: () => <div data-testid="term-body" />,
}));

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

/** Apply the theme (html data-theme + the store's resolved-theme fields). */
function useTheme(theme: Theme): void {
  applyTheme(theme);
  useStore.getState().setSettings({ theme });
}

/** Render a view under both themes, flushing effects, asserting clean each time. */
async function viewIsCleanInBothThemes(label: string, renderView: () => React.ReactNode) {
  for (const theme of THEMES) {
    useTheme(theme);
    const { unmount } = render(<>{renderView()}</>);
    // Flush micro/macrotasks so async provider calls (yaml/logs/status) settle.
    await new Promise((r) => setTimeout(r, 0));
    try {
      await expectNoViolations();
    } catch (e) {
      throw new Error(`${label} (${theme} theme): ${(e as Error).message}`);
    }
    unmount();
  }
}

describe("axe: every main view in both themes (B84)", () => {
  it("ClusterOverview", async () => {
    await connectAll(["freya"]);
    useStore.getState().setNav("overview");
    await viewIsCleanInBothThemes("ClusterOverview", () => <ClusterOverview />);
  });

  it("ResourceTable — pods", async () => {
    await connectAll(["freya"]);
    useStore.getState().setNav("pods");
    await viewIsCleanInBothThemes("ResourceTable(pods)", () => <ResourceTable />);
  });

  it("ResourceTable — problems (all-clusters merge)", async () => {
    await connectAll(["freya", "odin-staging"]);
    useStore.getState().setNav("problems");
    useStore.getState().setProblemsScope("all");
    await viewIsCleanInBothThemes("ResourceTable(problems)", () => <ResourceTable />);
  });

  it("ClusterSwitcher (multi-cluster rail)", async () => {
    await connectAll(["freya", "odin-staging", "loki-dev"]);
    await viewIsCleanInBothThemes("ClusterSwitcher", () => <ClusterSwitcher />);
  });

  it("DetailPanel (pod selected, logs tab)", async () => {
    await connectAll(["freya"]);
    const store = useStore.getState();
    store.setNav("pods");
    const row = store.rows.pods.find((r) => r.name === "heimdall-auth-6b8c9d5f7-qq3rt");
    if (!row) throw new Error("heimdall-auth missing");
    store.selectRow(row);
    await viewIsCleanInBothThemes("DetailPanel", () => <DetailPanel />);
  });

  it("TerminalPanel (open terminal)", async () => {
    await connectAll(["freya"]);
    useStore.getState().openTerminal("freya");
    await viewIsCleanInBothThemes("TerminalPanel", () => <TerminalPanel />);
  });
});
