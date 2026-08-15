/**
 * Terminal open/close component tests (B83): opening a terminal for a connected
 * cluster adds a cluster-badged tab, closing it removes the tab (and the panel,
 * when none remain), and closing the focused terminal refocuses the last
 * remaining one. The xterm body is stubbed — KubectlTerminal owns the pty/xterm
 * session and jsdom has no terminal DOM; the store's open/close contract is the
 * surface under test here (its slice tests already cover the connected-guard).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalPanel } from "./TerminalPanel";
import { useStore } from "../../store";
import { connectAll, resetStore, subscribeProvider } from "../../test/bootstrap";

vi.mock("./KubectlTerminal", () => ({
  KubectlTerminal: ({ terminal }: { terminal: { id: string } }) => (
    <div data-testid={`term-body-${terminal.id}`} />
  ),
}));

let off: (() => void) | undefined;
beforeEach(async () => {
  off?.();
  resetStore();
  off = subscribeProvider();
  await connectAll(["freya", "odin-staging"]);
});
afterAll(() => off?.());

describe("TerminalPanel open/close (B83)", () => {
  it("opening a terminal renders a cluster-badged tab; closing the last one hides the panel", async () => {
    const user = userEvent.setup();
    useStore.getState().openTerminal("freya");

    render(<TerminalPanel />);
    expect(screen.getByTitle("kubectl terminal · freya")).toBeInTheDocument();
    expect(screen.getByLabelText("close terminal freya")).toBeInTheDocument();

    await user.click(screen.getByLabelText("close terminal freya"));

    expect(useStore.getState().terminals).toHaveLength(0);
    expect(screen.queryByTitle("kubectl terminal · freya")).not.toBeInTheDocument();
  });

  it("closing the focused terminal refocuses the last remaining one", async () => {
    const user = userEvent.setup();
    const store = useStore.getState();
    store.openTerminal("freya");
    store.openTerminal("odin-staging");
    // The second open is focused.
    expect(useStore.getState().activeTerminalId).toBe(useStore.getState().terminals[1].id);

    render(<TerminalPanel />);
    expect(screen.getByTitle("kubectl terminal · freya")).toBeInTheDocument();
    expect(screen.getByTitle("kubectl terminal · odin-staging")).toBeInTheDocument();

    // Focus the freya tab, then close it.
    await user.click(screen.getByTitle("kubectl terminal · freya"));
    expect(useStore.getState().activeTerminalId).toBe(useStore.getState().terminals[0].id);
    await user.click(screen.getByLabelText("close terminal freya"));

    const after = useStore.getState();
    expect(after.terminals).toHaveLength(1);
    expect(after.terminals[0].cid).toBe("odin-staging");
    // Focus fell back to the remaining terminal.
    expect(after.activeTerminalId).toBe(after.terminals[0].id);
  });
});
