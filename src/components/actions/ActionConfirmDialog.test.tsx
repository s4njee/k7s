/**
 * Confirmation dialog component tests (B83): the confirm text matches the
 * documented wording, Cancel only cancels, Confirm fires with the action id, and
 * a busy dialog shows the pending state instead of inviting a second click.
 * Uses the restart verb on a pod — one with no drain/uninstall side-effect, so
 * the test needs no provider.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import type { ActionDef, ActionId } from "../../lib/actions";
import type { Row } from "../../providers/types";

const RESTART: ActionDef = { id: "restart", label: "Restart…", mode: "confirm", bulk: true };

const pod: Row = {
  uid: "pod:prod/heimdall-auth-6b8c9d5f7-qq3rt",
  name: "heimdall-auth-6b8c9d5f7-qq3rt",
  namespace: "prod",
  cells: [{ text: "heimdall-auth-6b8c9d5f7-qq3rt", tone: "primary" }],
};

describe("ActionConfirmDialog (B83)", () => {
  it("shows the confirm wording for the action and object", () => {
    render(
      <ActionConfirmDialog
        id="restart"
        kind="pods"
        rows={[pod]}
        actions={[RESTART]}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(
      screen.getByText(/Restart heimdall-auth-6b8c9d5f7-qq3rt\? Deletes the pod/),
    ).toBeInTheDocument();
    expect(screen.getByText("Restart")).toBeInTheDocument();
  });

  it("Cancel only cancels; Confirm fires with the action id", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ActionConfirmDialog
        id="restart"
        kind="pods"
        rows={[pod]}
        actions={[RESTART]}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByText("Restart"));
    expect(onConfirm).toHaveBeenCalledWith("restart" as ActionId);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a busy dialog shows the pending verb and is marked non-interactive", () => {
    render(
      <ActionConfirmDialog
        id="restart"
        kind="pods"
        rows={[pod]}
        actions={[RESTART]}
        busy
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText("…")).toBeInTheDocument();
    expect(screen.getByText("…")).toHaveAttribute("aria-disabled", "true");
  });
});
