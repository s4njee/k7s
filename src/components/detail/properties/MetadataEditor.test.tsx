/**
 * Metadata editor tests (B88/v5 B62): lists the row's labels/annotations, warns
 * by name when removing a label a Service selects on, adds a label, and shows a
 * Helm-managed notice. Runs against the demo MockProvider.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetadataEditor } from "./MetadataEditor";
import { useStore } from "../../../store";
import { connectAll, resetStore, subscribeProvider } from "../../../test/bootstrap";

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

async function selectPod() {
  await connectAll(["freya"]);
  const s = useStore.getState();
  s.setNav("pods");
  const row = s.rows.pods.find((r) => r.name === "heimdall-auth-6b8c9d5f7-qq3rt");
  if (!row) throw new Error("heimdall-auth missing");
  s.selectRow(row);
}

describe("MetadataEditor (B88)", () => {
  it("lists the row's labels and annotations", async () => {
    await selectPod();
    render(<MetadataEditor onChanged={() => {}} />);
    // The demo pod carries an `app` label and the k7s.demo annotations.
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("k7s.demo/owner")).toBeInTheDocument();
  });

  it("removing a label a Service selects on warns naming the dependent", async () => {
    await selectPod();
    const user = userEvent.setup();
    render(<MetadataEditor onChanged={() => {}} />);
    await user.click(screen.getByRole("button", { name: "remove app" }));
    // The demo reports web-svc as selecting on the `app` label.
    expect(await screen.findByRole("alert")).toHaveTextContent("web-svc");
  });

  it("adding a label renders it", async () => {
    await selectPod();
    const user = userEvent.setup();
    render(<MetadataEditor onChanged={() => {}} />);
    await user.click(screen.getByRole("button", { name: /add label/ }));
    await user.type(screen.getByLabelText("new labels key"), "team");
    await user.type(screen.getByLabelText("new labels value"), "billing");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("team")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
  });

  it("warns when the object is Helm-managed", async () => {
    await selectPod();
    const s = useStore.getState();
    const row = s.selectedRow!;
    s.selectRow({
      ...row,
      labels: { ...(row.labels ?? {}), "app.kubernetes.io/managed-by": "Helm" },
    });
    render(<MetadataEditor onChanged={() => {}} />);
    expect(screen.getByText(/managed by Helm/)).toBeInTheDocument();
  });
});
