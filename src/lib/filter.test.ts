import { describe, expect, it } from "vitest";
import { parseFilter, matchesFilter, isEmptyFilter, selectorFilter } from "./filter";
import type { Row } from "../providers/types";

const row = (over: Partial<Row>): Row => ({ uid: "u", name: "x", cells: [], ...over });

describe("parseFilter", () => {
  it("treats a bare word as name text, no selectors", () => {
    expect(parseFilter("notes")).toEqual({ text: "notes", labels: [] });
  });

  it("lowercases the text so matching is case-insensitive", () => {
    expect(parseFilter("Notes").text).toBe("notes");
  });

  it("splits a key=value term off as a selector", () => {
    expect(parseFilter("app=notes")).toEqual({ text: "", labels: [["app", "notes"]] });
  });

  it("accepts comma-separated selectors (a matchLabels string pastes in)", () => {
    expect(parseFilter("app=notes,tier=web").labels).toEqual([
      ["app", "notes"],
      ["tier", "web"],
    ]);
  });

  it("mixes free text and selectors, in any order", () => {
    const f = parseFilter("app=notes djpwx");
    expect(f.labels).toEqual([["app", "notes"]]);
    expect(f.text).toBe("djpwx");
  });

  it("does not mistake a value's dots for a new term", () => {
    expect(parseFilter("version=1.2.3").labels).toEqual([["version", "1.2.3"]]);
  });

  it("a leading = (empty key) is text, not a selector", () => {
    // indexOf('=') === 0, so it's not a key=value.
    expect(parseFilter("=x")).toEqual({ text: "=x", labels: [] });
  });

  it("is empty for whitespace", () => {
    expect(isEmptyFilter(parseFilter("   "))).toBe(true);
  });
});

describe("matchesFilter", () => {
  const pod = row({
    name: "notes-6b6d775f4-djpwx",
    labels: { app: "notes", tier: "web" },
    cells: [{ text: "notes-6b6d775f4-djpwx", tone: "primary" }],
  });

  it("matches a name substring", () => {
    expect(matchesFilter(pod, parseFilter("djpwx"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("nginx"), "pods")).toBe(false);
  });

  it("matches an exact label selector", () => {
    expect(matchesFilter(pod, parseFilter("app=notes"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("app=nginx"), "pods")).toBe(false);
  });

  it("ANDs multiple selectors", () => {
    expect(matchesFilter(pod, parseFilter("app=notes,tier=web"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("app=notes,tier=db"), "pods")).toBe(false);
  });

  it("requires both the selector and the text to match", () => {
    expect(matchesFilter(pod, parseFilter("app=notes djpwx"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("app=notes zzz"), "pods")).toBe(false);
  });

  it("rejects a row with no labels when a selector is present", () => {
    const svc = row({ name: "notes", labels: undefined });
    expect(matchesFilter(svc, parseFilter("app=notes"), "services")).toBe(false);
  });

  it("matches everything when the filter is empty", () => {
    expect(matchesFilter(pod, parseFilter(""), "pods")).toBe(true);
  });

  it("matches events across their cells, since the event name is opaque", () => {
    const ev = row({
      name: "notes.17c3f",
      cells: [
        { text: "Warning", tone: "err" },
        { text: "FailedMount", tone: "primary" },
      ],
    });
    // Not in the name, but in a cell.
    expect(matchesFilter(ev, parseFilter("failedmount"), "events")).toBe(true);
    expect(matchesFilter(ev, parseFilter("backoff"), "events")).toBe(false);
  });
});

describe("selectorFilter", () => {
  it("renders matchLabels as a stable, sorted k=v,k2=v2 string", () => {
    expect(selectorFilter({ tier: "web", app: "notes" })).toBe("app=notes,tier=web");
  });

  it("round-trips back through parseFilter", () => {
    const s = selectorFilter({ app: "notes", tier: "web" });
    expect(parseFilter(s).labels).toEqual([
      ["app", "notes"],
      ["tier", "web"],
    ]);
  });

  it("is empty for no labels", () => {
    expect(selectorFilter({})).toBe("");
  });
});
