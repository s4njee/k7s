/**
 * Tests for the app-level key bindings (B10, B28).
 *
 * These drive the real document listener the hook installs, rather than a copy of
 * its logic: the bindings are all about *interaction* — that ⌘K works while
 * typing, that `:` doesn't, and that Escape unwinds one layer at a time — and
 * that only shows up when real events are dispatched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import type { Row } from "../providers/types";

import { useGlobalKeys } from "./useGlobalKeys";
import { cleanup, renderHook } from "./testUtils";

const row = (name: string, pod = false): Row => ({
  uid: name,
  name,
  cells: [],
  ...(pod
    ? {
        pod: {
          node: "freya",
          containers: ["app"],
          status: "Running",
          ready: "1/1",
          restarts: 0,
          creationTs: "",
          statusTone: "ok" as const,
        },
      }
    : {}),
});

/** Dispatch a key on the document, as a real keypress would arrive. */
function press(key: string, opts: KeyboardEventInit = {}) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));
}

beforeEach(() => {
  renderHook(useGlobalKeys);
  useStore.setState({
    paletteOpen: false,
    openMenu: null,
    tableFilter: "",
    selectedRow: null,
    selection: { selected: [], anchor: null },
    nav: "pods",
    activeTab: "logs",
  });
});

afterEach(cleanup);

describe("⌘K", () => {
  it("opens the palette", () => {
    press("k", { metaKey: true });
    expect(useStore.getState().paletteOpen).toBe(true);
  });

  it("toggles it closed again", () => {
    press("k", { metaKey: true });
    press("k", { metaKey: true });
    expect(useStore.getState().paletteOpen).toBe(false);
  });

  it("works with ctrl too, for non-Mac habits", () => {
    press("k", { ctrlKey: true });
    expect(useStore.getState().paletteOpen).toBe(true);
  });

  it("is not a bare k — that's the table's move-up key", () => {
    press("k");
    expect(useStore.getState().paletteOpen).toBe(false);
  });
});

describe(": (the k9s idiom)", () => {
  it("opens the palette", () => {
    press(":");
    expect(useStore.getState().paletteOpen).toBe(true);
  });

  it("is ignored while typing — it's a legal character in a filter", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    press(":");
    expect(useStore.getState().paletteOpen).toBe(false);

    input.remove();
  });
});

describe("Escape cascade", () => {
  it("closes the palette first, leaving everything under it alone", () => {
    // The whole point: closing the palette must not also clear the filter and
    // close the panel behind it.
    useStore.setState({
      paletteOpen: true,
      tableFilter: "wiki",
      selectedRow: row("wiki-x"),
    });

    press("Escape");

    const s = useStore.getState();
    expect(s.paletteOpen).toBe(false);
    expect(s.tableFilter).toBe("wiki");
    expect(s.selectedRow).not.toBeNull();
  });

  it("then closes an open menu", () => {
    useStore.setState({ openMenu: "ns", tableFilter: "wiki" });
    press("Escape");
    expect(useStore.getState().openMenu).toBeNull();
    expect(useStore.getState().tableFilter).toBe("wiki");
  });

  /**
   * A multi-selection is armed for a destructive action and has no other keyboard
   * dismissal, so it unwinds before the filter and the panel.
   */
  it("clears a multi-row selection before the filter", () => {
    useStore.setState({
      tableFilter: "wiki",
      selection: { selected: ["a", "b"], anchor: "a" },
    });
    press("Escape");
    expect(useStore.getState().selection.selected).toEqual([]);
    expect(useStore.getState().tableFilter).toBe("wiki");
  });

  /** One selected row is not a multi-selection; Escape behaves as it always did. */
  it("does not treat a single selected row as a selection layer", () => {
    useStore.setState({
      tableFilter: "wiki",
      selection: { selected: ["a"], anchor: "a" },
    });
    press("Escape");
    expect(useStore.getState().tableFilter).toBe("");
  });

  it("then clears the filter", () => {
    useStore.setState({ tableFilter: "wiki", selectedRow: row("wiki-x") });
    press("Escape");
    expect(useStore.getState().tableFilter).toBe("");
    expect(useStore.getState().selectedRow).not.toBeNull();
  });

  it("then closes the detail panel", () => {
    useStore.setState({ selectedRow: row("wiki-x") });
    press("Escape");
    expect(useStore.getState().selectedRow).toBeNull();
  });
});

describe("[ / ] tab cycling", () => {
  it("cycles a pod's tabs", () => {
    useStore.setState({ nav: "pods", selectedRow: row("p", true), activeTab: "logs" });
    press("]");
    expect(useStore.getState().activeTab).toBe("properties");
  });

  // The drift this shares a source of truth to prevent: nodes gained Properties
  // (B18) and Metrics (B27) long after the cycle keys were written, and the old
  // hardcoded list would have cycled onto tabs that weren't rendered.
  it("cycles a node's real tabs, including Metrics", () => {
    useStore.setState({ nav: "nodes", selectedRow: row("freya"), activeTab: "properties" });
    press("]");
    expect(useStore.getState().activeTab).toBe("metrics");
  });

  it("cycles a Helm release's Properties/YAML, never landing on Events", () => {
    // B35 gave Helm a Properties tab; it still has no Events. Tabs are
    // [Properties, YAML], so cycling from YAML wraps to Properties, not Events.
    useStore.setState({ nav: "helm", selectedRow: row("traefik"), activeTab: "yaml" });
    press("]");
    expect(useStore.getState().activeTab).toBe("properties");
    press("]");
    expect(useStore.getState().activeTab).toBe("yaml");
  });

  it("wraps around", () => {
    useStore.setState({ nav: "pods", selectedRow: row("p", true), activeTab: "logs" });
    press("[");
    expect(useStore.getState().activeTab).toBe("events");
  });

  it("does nothing with no selection", () => {
    useStore.setState({ selectedRow: null, activeTab: "logs" });
    press("]");
    expect(useStore.getState().activeTab).toBe("logs");
  });
});
