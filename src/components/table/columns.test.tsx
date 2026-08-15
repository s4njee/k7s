/**
 * Column-config component tests (B87): hiding a column removes it from the
 * rendered table, adding a label custom column renders its values (missing → —),
 * the ↑/↓ buttons reorder without drag, and reset restores the defaults.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceTable } from "./ResourceTable";
import { useStore } from "../../store";
import { connectAll, resetStore, subscribeProvider } from "../../test/bootstrap";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

async function openColumns() {
  await userEvent.setup().click(screen.getByRole("button", { name: /columns/ }));
}

const headers = () =>
  screen
    .getAllByRole("columnheader")
    .map((h) => within(h).getByRole("button").textContent?.replace(/[ ▲▼]/g, "") ?? "");

describe("column configuration (B87)", () => {
  it("hiding NAMESPACE removes the column; reopening shows it unchecked", async () => {
    await connectAll(["freya"]);
    useStore.getState().setNav("pods");
    const user = userEvent.setup();
    render(<ResourceTable />);

    expect(headers()).toContain("NAMESPACE");
    await openColumns();
    const nsCheckbox = screen.getByRole("checkbox", { name: "NAMESPACE" });
    expect(nsCheckbox).toBeChecked();
    await user.click(nsCheckbox);
    await user.click(screen.getByRole("button", { name: /columns/ })); // close

    expect(headers()).not.toContain("NAMESPACE");

    await openColumns();
    expect(screen.getByRole("checkbox", { name: "NAMESPACE" })).not.toBeChecked();
  });

  it("adding a labels.app custom column renders the label values", async () => {
    await connectAll(["freya"]);
    useStore.getState().setNav("pods");
    const user = userEvent.setup();
    render(<ResourceTable />);

    await openColumns();
    await user.click(screen.getByText("Add custom column…"));
    await user.type(screen.getByLabelText("key or path"), "app");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: /columns/ })); // close

    // The custom column header is named "app".
    expect(headers()).toContain("app");
    // A pod row carries the derived app label (e.g. valkyrie-api).
    expect(screen.getAllByText("valkyrie-api")).not.toHaveLength(0);
  });

  it("the ↑/↓ buttons reorder columns without drag", async () => {
    await connectAll(["freya"]);
    useStore.getState().setNav("pods");
    const user = userEvent.setup();
    render(<ResourceTable />);

    await openColumns();
    await user.click(screen.getByRole("button", { name: "move CPU up" }));
    await user.click(screen.getByRole("button", { name: /columns/ })); // close

    const cols = headers();
    expect(cols[0]).toBe("CPU");
    expect(cols).toContain("NAME"); // the rest follow in the natural order
  });

  it("reset restores hidden columns", async () => {
    await connectAll(["freya"]);
    useStore.getState().setNav("pods");
    const user = userEvent.setup();
    render(<ResourceTable />);

    await openColumns();
    await user.click(screen.getByRole("checkbox", { name: "NAMESPACE" }));
    await user.click(screen.getByText("Reset to defaults"));
    await user.click(screen.getByRole("button", { name: /columns/ })); // close

    expect(headers()).toContain("NAMESPACE");
  });
});
