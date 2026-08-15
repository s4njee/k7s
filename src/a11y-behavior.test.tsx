/**
 * B84 behavioral checks the axe tests can't cover: modal focus returns to the
 * invoking control, and the keyboard-only flow works (a nav item activates with
 * Enter, the detail tab strip cycles with the arrow keys).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WatchFooter } from "./components/sidebar/WatchFooter";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { NavList } from "./components/sidebar/NavList";
import { DetailPanel } from "./components/detail/DetailPanel";
import { useStore } from "./store";
import { connectAll, resetStore, subscribeProvider } from "./test/bootstrap";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

describe("B84 focus management", () => {
  it("closing Settings returns focus to the gear that opened it", async () => {
    await connectAll(["freya"]);
    const user = userEvent.setup();
    render(
      <>
        <WatchFooter />
        <SettingsPanel />
      </>,
    );

    const gear = screen.getByRole("button", { name: "settings" });
    await user.click(gear);
    // The dialog opened and grabbed focus inside itself (the panel, tabindex="-1").
    expect(useStore.getState().settingsOpen).toBe(true);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape closes; focus must return to the gear.
    await user.keyboard("{Escape}");
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(document.activeElement).toBe(gear);
  });
});

describe("B84 keyboard-only", () => {
  it("a nav item activates with Enter", async () => {
    await connectAll(["freya"]);
    const user = userEvent.setup();
    render(<NavList />);

    const pods = screen.getByRole("button", { name: /Pods/ });
    pods.focus();
    await user.keyboard("{Enter}");

    expect(useStore.getState().nav).toBe("pods");
  });

  it("the detail tab strip cycles with the arrow keys", async () => {
    await connectAll(["freya"]);
    const store = useStore.getState();
    store.setNav("pods");
    const row = store.rows.pods.find((r) => r.name === "heimdall-auth-6b8c9d5f7-qq3rt");
    if (!row) throw new Error("heimdall-auth missing");
    store.selectRow(row); // opens on Logs

    const user = userEvent.setup();
    render(<DetailPanel />);

    // Logs is active; ArrowRight should move to the next tab (Properties).
    const logsTab = screen.getByRole("tab", { name: "Logs" });
    expect(useStore.getState().activeTab).toBe("logs");
    logsTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(useStore.getState().activeTab).toBe("properties");

    await user.keyboard("{ArrowRight}");
    expect(useStore.getState().activeTab).toBe("metrics");
  });
});
