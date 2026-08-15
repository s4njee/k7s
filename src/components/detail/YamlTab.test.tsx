/**
 * YAML dry-run dialog component tests (B83): Edit → preview what the server
 * would store (dry run) → back or apply. The component under test is YamlTab's
 * flow, so CodeEditor is stubbed to a plain textarea (CodeMirror's layout doesn't
 * exist in jsdom); the dry-run itself runs against the real MockProvider, which
 * stamps the defaulting/mutation a real cluster's admission chain would.
 */

import { useState as reactUseState } from "react";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { YamlTab } from "./YamlTab";
import { useStore } from "../../store";
import { connectAll, resetStore, subscribeProvider } from "../../test/bootstrap";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({
    value,
    editable,
    onChange,
  }: {
    value: string;
    editable: boolean;
    onChange?: (text: string) => void;
  }) => {
    // Mirror the real editor's contract: uncontrolled after mount (initial doc
    // from `value`), edits reported through onChange.
    const [text, setText] = reactUseState(value);
    if (!editable || !onChange) return <div data-testid="yaml-readonly" />;
    return (
      <textarea
        aria-label="yaml editor"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
      />
    );
  },
}));

let off: (() => void) | undefined;
beforeEach(() => {
  off?.();
  resetStore();
  off = subscribeProvider();
});
afterAll(() => off?.());

async function openYamlTab() {
  await connectAll(["freya"]);
  const store = useStore.getState();
  store.setNav("pods");
  const row = store.rows.pods.find((r) => r.name === "heimdall-auth-6b8c9d5f7-qq3rt");
  if (!row) throw new Error("heimdall-auth pod missing from demo rows");
  store.selectRow(row);
  store.setActiveTab("yaml");
}

describe("YamlTab dry run (B83)", () => {
  it("editing then previewing enters review mode with the server's answer", async () => {
    await openYamlTab();
    const user = userEvent.setup();
    render(<YamlTab />);

    const edit = await screen.findByText("✎ Edit");
    await user.click(edit);

    // Edit mode: a draft editor is live, fed by the store.
    const editor = screen.getByLabelText("yaml editor") as HTMLTextAreaElement;
    expect(editor.value).toContain("kind: Pod");

    // Change the draft, then ask the server what it would do.
    await user.type(editor, "\nmetadata:\n  labels:\n    k7s.demo/edited: \"true\"");
    await user.click(screen.getByText(/Preview changes/));

    // Review mode: the apply is only reachable from here, and it shows what the
    // server rewrote (the dry-run proposed text includes the mutating annotation).
    await waitFor(() => {
      expect(screen.getByText("Apply for real")).toBeInTheDocument();
      expect(screen.getByText("Back to editing")).toBeInTheDocument();
    });
    expect(screen.getByText(/k7s\.demo\/mutated/)).toBeInTheDocument();
  });

  it("cancel discards the draft and returns to read-only", async () => {
    await openYamlTab();
    const user = userEvent.setup();
    render(<YamlTab />);

    await user.click(await screen.findByText("✎ Edit"));
    const editor = screen.getByLabelText("yaml editor");
    await user.type(editor, "\nmetadata:\n  labels:\n    k7s.demo/edited: \"true\"");

    await user.click(screen.getByText("Cancel"));
    // Back to read-only: no editor, Edit button again, no review buttons.
    expect(screen.queryByLabelText("yaml editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Apply for real")).not.toBeInTheDocument();
    expect(screen.getByText("✎ Edit")).toBeInTheDocument();
    // The draft was discarded from the store.
    expect(useStore.getState().yamlEditing).toBe(false);
  });
});
