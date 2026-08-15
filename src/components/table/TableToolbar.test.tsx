/**
 * Saved-views toolbar tests (B60): saving captures the current table state
 * (nav/namespace/filter/sort), applying a built-in sets nav + filter, and the
 * delete button removes a saved view.
 */

import { createRef } from "react";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TableToolbar } from "./TableToolbar";
import { useStore } from "../../store";
import { connectAll, resetStore, subscribeProvider } from "../../test/bootstrap";
import type { SavedView } from "../../lib/views";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

const filterRef = createRef<HTMLInputElement>();

const POD_COLUMNS = ["NAME", "NAMESPACE", "READY", "RESTARTS", "CPU", "MEM", "AGE", "STATUS"];

const renderToolbar = (filter = "") =>
  render(
    <TableToolbar
      filterRef={filterRef}
      tableFilter={filter}
      setTableFilter={() => {}}
      rows={[]}
      columns={POD_COLUMNS}
    />,
  );

describe("TableToolbar saved views (B60)", () => {
  it("saving captures nav, namespace, filter, and sort", async () => {
    await connectAll(["freya"]);
    const store = useStore.getState();
    store.setNav("pods");
    store.setNamespace("prod");
    store.setTableFilter("status=CrashLoopBackOff");
    store.toggleSort(3); // RESTARTS column

    const user = userEvent.setup();
    renderToolbar("status=CrashLoopBackOff");

    await user.click(screen.getByRole("button", { name: /views/ }));
    await user.click(screen.getByText("Save current view…"));
    await user.type(screen.getByLabelText("view name"), "crashloop");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = useStore.getState().savedViewsByCid["freya"];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: "crashloop",
      kind: "pods",
      namespace: "prod",
      filter: "status=CrashLoopBackOff",
      sortColName: "RESTARTS",
      sortDir: "asc",
    });
  });

  it("applying a built-in view sets nav and filter", async () => {
    await connectAll(["freya"]);
    useStore.getState().setNav("overview");

    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole("button", { name: /views/ }));
    await user.click(screen.getByText("Unhealthy pods"));

    const after = useStore.getState();
    expect(after.nav).toBe("pods");
    expect(after.tableFilter).toBe("status=CrashLoopBackOff|Error|Failed|Evicted|OOMKilled");
  });

  it("deleting a saved view removes it", async () => {
    await connectAll(["freya"]);
    const view: SavedView = {
      id: "crashloop",
      name: "crashloop",
      kind: "pods",
      namespace: "all",
      filter: "status=CrashLoopBackOff",
      sortColName: null,
      sortDir: "asc",
    };
    useStore.getState().addSavedView("freya", view);

    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole("button", { name: /views/ }));
    await user.click(screen.getByRole("button", { name: "delete view crashloop" }));

    expect(useStore.getState().savedViewsByCid["freya"]).toHaveLength(0);
  });
});
