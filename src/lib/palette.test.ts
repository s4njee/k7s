/**
 * Tests for the palette's result building (B28), written against orion-shaped
 * data. These pin the acceptance criteria: two keystrokes find the crash-looper,
 * "releases" reaches the Helm view, "applications" reaches the Argo CRD kind, and
 * an unwatched CRD contributes no phantom objects.
 */

import { describe, expect, it } from "vitest";
import { buildPalette, parseQuery, type PaletteContext } from "./palette";
import type { CustomKind, Row } from "../providers/types";

/** A minimal row; the palette only reads name/namespace. */
const row = (name: string, namespace?: string): Row => ({
  uid: `${namespace ?? ""}/${name}`,
  name,
  namespace,
  cells: [],
});

const CUSTOM_KINDS: CustomKind[] = [
  {
    id: "argoproj.io/applications",
    group: "argoproj.io",
    version: "v1alpha1",
    kind: "Application",
    plural: "applications",
    namespaced: true,
  },
  {
    id: "traefik.io/ingressroutes",
    group: "traefik.io",
    version: "v1alpha1",
    kind: "IngressRoute",
    plural: "ingressroutes",
    namespaced: true,
  },
];

const ctx = (over: Partial<PaletteContext> = {}): PaletteContext => ({
  rows: {
    pods: [
      row("notes-6b6d775f4-djpwx", "notes"),
      row("svclb-media-notes-nextra-ab930ae9", "kube-system"),
      row("gitops-server-765575f778-np7rb", "gitops"),
      row("search-redis-6bb8d4fb9-kcp4z", "default"),
    ],
    services: [row("gitops-server", "gitops")],
    nodes: [row("orion"), row("lyra"), row("draco")],
    helm: [row("traefik", "kube-system")],
    // Events carry opaque ids; they must never crowd the list.
    events: [row("notes-6b6d775f4-djpwx.17c3f8a2b1", "notes")],
    // A CRD kind whose watcher has never run contributes no rows at all — which
    // is the point of the "no phantom objects" case below.
    "argoproj.io/applications": [],
  },
  customKinds: CUSTOM_KINDS,
  nav: "pods",
  selectedRow: null,
  ...over,
});

describe("parseQuery", () => {
  it("splits a leading ns: scope off the text", () => {
    expect(parseQuery("ns:prod notes")).toEqual({ namespace: "prod", text: "notes" });
  });

  it("accepts a scope with no text yet", () => {
    expect(parseQuery("ns:prod")).toEqual({ namespace: "prod", text: "" });
  });

  it("treats a bare ns: as no scope, so results don't vanish mid-keystroke", () => {
    expect(parseQuery("ns:")).toEqual({ text: "" });
  });

  it("only honours the scope at the start — mid-query it's just text", () => {
    expect(parseQuery("notes ns:prod")).toEqual({ text: "notes ns:prod" });
  });

  it("passes an ordinary query through", () => {
    expect(parseQuery("  notes  ")).toEqual({ text: "notes" });
  });
});

describe("buildPalette", () => {
  it("shows where you can go on an empty query, not every object in the cluster", () => {
    const out = buildPalette("", ctx());
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((i) => i.type !== "object")).toBe(true);
  });

  // The backlog's headline case: two keystrokes and Enter reach the crash-looper.
  it("finds the crash-looping pod from 'not', ahead of the name that merely contains it", () => {
    const out = buildPalette("not", ctx());
    const objects = out.filter((i) => i.type === "object");
    expect(objects[0].label).toBe("notes-6b6d775f4-djpwx");
  });

  it("reaches the Helm view by name", () => {
    const out = buildPalette("releases", ctx());
    expect(out[0]).toMatchObject({ type: "kind", id: "helm" });
  });

  it("reaches a CRD kind by its plural, which its Kind name doesn't contain", () => {
    // "applications" is longer than the label "Application", so only matching the
    // id ("argoproj.io/applications") makes this work.
    const out = buildPalette("applications", ctx());
    expect(out[0]).toMatchObject({ type: "kind", id: "argoproj.io/applications" });
  });

  it("reaches a built-in kind by its id", () => {
    const out = buildPalette("pods", ctx());
    expect(out[0]).toMatchObject({ type: "kind", id: "pods" });
  });

  // The other acceptance case: no phantom entries for kinds we haven't loaded.
  it("lists no objects for a CRD kind whose watcher hasn't run", () => {
    const out = buildPalette("app", ctx());
    expect(out.some((i) => i.type === "object" && i.kind === "argoproj.io/applications")).toBe(
      false,
    );
    // The kind itself is still reachable — jumping to it is what loads its rows.
    expect(out.some((i) => i.type === "kind" && i.id === "argoproj.io/applications")).toBe(true);
  });

  it("never offers an event as an object — its name is an opaque id", () => {
    const out = buildPalette("17c3f8a2b1", ctx());
    expect(out.some((i) => i.type === "object" && i.kind === "events")).toBe(false);
  });

  it("finds an object by namespace/name", () => {
    const out = buildPalette("gitops/server", ctx());
    expect(out.some((i) => i.type === "object" && i.label.startsWith("gitops-server"))).toBe(true);
  });

  it("scopes objects with ns:, without hiding the kinds", () => {
    const out = buildPalette("ns:gitops server", ctx());
    const objects = out.filter((i) => i.type === "object");
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.every((i) => i.type === "object" && i.row.namespace === "gitops")).toBe(true);
  });

  it("labels an object with its kind and namespace, so same-named objects are distinct", () => {
    const out = buildPalette("gitops-server", ctx());
    const objects = out.filter((i) => i.type === "object");
    // A Service and a Pod share the name; both are offered, told apart by hint.
    const hints = objects.map((i) => (i.type === "object" ? i.hint : ""));
    expect(hints.some((h) => h.startsWith("Pods"))).toBe(true);
    expect(hints.some((h) => h.startsWith("Services"))).toBe(true);
  });

  it("carries the row through, so selecting it needs no second lookup", () => {
    const out = buildPalette("notes-6b6d775f4-djpwx", ctx());
    const first = out[0];
    expect(first.type).toBe("object");
    if (first.type === "object") {
      expect(first.kind).toBe("pods");
      expect(first.row.namespace).toBe("notes");
    }
  });

  // ---- actions ----

  it("always offers the app commands", () => {
    const out = buildPalette("settings", ctx());
    expect(out[0]).toMatchObject({ type: "action", id: "settings" });
  });

  it("offers cordon only when a node is selected", () => {
    const without = buildPalette("cordon", ctx());
    expect(without.some((i) => i.type === "action" && i.id === "cordon")).toBe(false);

    const with_ = buildPalette("cordon", ctx({ nav: "nodes", selectedRow: row("orion") }));
    expect(with_.some((i) => i.type === "action" && i.id === "cordon")).toBe(true);
  });

  it("names the node in the action, so what it will do is unambiguous", () => {
    const out = buildPalette("cordon", ctx({ nav: "nodes", selectedRow: row("orion") }));
    const cordon = out.find((i) => i.type === "action" && i.id === "cordon");
    expect(cordon?.label).toBe("Cordon orion");
  });

  it("never offers delete or drain — they need a confirmation the palette has no room for", () => {
    const out = buildPalette("", ctx({ nav: "nodes", selectedRow: row("orion") }));
    const ids = out.filter((i) => i.type === "action").map((i) => (i.type === "action" ? i.id : ""));
    expect(ids).not.toContain("delete");
    expect(ids).not.toContain("drain");
  });

  // ---- ranking and shape ----

  it("ranks all classes in one list, so a strong object beats a weak kind", () => {
    // "notes" matches the pod exactly-ish and no kind well.
    const out = buildPalette("notes", ctx());
    expect(out[0].type).toBe("object");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(buildPalette("zzzqqq", ctx())).toEqual([]);
  });

  it("caps the list rather than returning the whole cluster", () => {
    const many = Array.from({ length: 500 }, (_, i) => row(`pod-${i}`, "prod"));
    const out = buildPalette("pod", ctx({ rows: { pods: many } }));
    expect(out.filter((i) => i.type === "object").length).toBeLessThanOrEqual(25);
  });

  it("ranks deterministically, so equal scores don't shuffle between renders", () => {
    const a = buildPalette("a", ctx()).map((i) => i.label);
    const b = buildPalette("a", ctx()).map((i) => i.label);
    expect(a).toEqual(b);
  });
});
