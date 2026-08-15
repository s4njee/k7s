/**
 * Table filter/sort component tests (B83): the toolbar filter narrows rows, the
 * header toggles sort direction, and a filter matching nothing shows the honest
 * empty state. Runs against freya's demo pod rows (14 pods) via the store, with
 * the MockProvider feeding the same data the app shows.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceTable } from "./ResourceTable";
import { useStore } from "../../store";
import { connectAll, resetStore, subscribeProvider } from "../../test/bootstrap";

let off: (() => void) | undefined;
beforeEach(async () => {
  off?.();
  resetStore();
  off = subscribeProvider();
  await connectAll(["freya"]);
  useStore.getState().setNav("pods");
});
afterAll(() => off?.());

/** The first visible table row's text (virtual tables key rows by index). */
function firstRow(): string {
  return document.querySelector('[data-row-index="0"]')?.textContent ?? "";
}

describe("ResourceTable filter/sort (B83)", () => {
  it("typing in the filter narrows the rows to matches", async () => {
    const user = userEvent.setup();
    render(<ResourceTable />);

    expect(screen.getByText("heimdall-auth-6b8c9d5f7-qq3rt")).toBeInTheDocument();
    expect(screen.getByText("valkyrie-api-7d9f8b64d-x2k4n")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("filter…"), "heimdall");

    expect(screen.getByText("heimdall-auth-6b8c9d5f7-qq3rt")).toBeInTheDocument();
    expect(screen.queryByText("valkyrie-api-7d9f8b64d-x2k4n")).not.toBeInTheDocument();
  });

  it("clicking the NAME header sorts asc then desc, and flips the arrow", async () => {
    const user = userEvent.setup();
    render(<ResourceTable />);

    // Unsorted: freya's prototype order starts with valkyrie-api.
    expect(firstRow()).toContain("valkyrie-api-7d9f8b64d-x2k4n");

    const nameHeader = screen.getByRole("columnheader", { name: /^NAME(?: ▲| ▼)?$/ });
    await user.click(nameHeader); // asc
    expect(firstRow()).toContain("bifrost-gateway-5c7dd4f6b-jl2mn");
    expect(screen.getByRole("columnheader", { name: /^NAME(?: ▲| ▼)?$/ })).toHaveTextContent("▲");

    await user.click(nameHeader); // desc
    expect(firstRow()).toContain("yggdrasil-db-1");
    expect(screen.getByRole("columnheader", { name: /^NAME(?: ▲| ▼)?$/ })).toHaveTextContent("▼");
  });

  it("a filter matching nothing shows the empty state", async () => {
    const user = userEvent.setup();
    render(<ResourceTable />);
    await user.type(screen.getByPlaceholderText("filter…"), "no-such-pod-xyz");
    expect(screen.getByText("no resources match filter")).toBeInTheDocument();
  });
});
