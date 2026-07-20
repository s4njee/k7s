import { describe, expect, it } from "vitest";
import { parseFilter, matchesFilter, isEmptyFilter, selectorFilter } from "./filter";
import type { Row } from "../providers/types";

const row = (over: Partial<Row>): Row => ({ uid: "u", name: "x", cells: [], ...over });

describe("parseFilter", () => {
  it("treats a bare word as name text, no selectors", () => {
    expect(parseFilter("wiki")).toEqual({ text: "wiki", labels: [] });
  });

  it("lowercases the text so matching is case-insensitive", () => {
    expect(parseFilter("Wiki").text).toBe("wiki");
  });

  it("splits a key=value term off as a selector", () => {
    expect(parseFilter("app=wiki")).toEqual({ text: "", labels: [["app", "wiki"]] });
  });

  it("accepts comma-separated selectors (a matchLabels string pastes in)", () => {
    expect(parseFilter("app=wiki,tier=web").labels).toEqual([
      ["app", "wiki"],
      ["tier", "web"],
    ]);
  });

  it("mixes free text and selectors, in any order", () => {
    const f = parseFilter("app=wiki djpwx");
    expect(f.labels).toEqual([["app", "wiki"]]);
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
    name: "wiki-6b6d775f4-djpwx",
    labels: { app: "wiki", tier: "web" },
    cells: [{ text: "wiki-6b6d775f4-djpwx", tone: "primary" }],
  });

  it("matches a name substring", () => {
    expect(matchesFilter(pod, parseFilter("djpwx"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("nginx"), "pods")).toBe(false);
  });

  it("matches an exact label selector", () => {
    expect(matchesFilter(pod, parseFilter("app=wiki"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("app=nginx"), "pods")).toBe(false);
  });

  it("ANDs multiple selectors", () => {
    expect(matchesFilter(pod, parseFilter("app=wiki,tier=web"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("app=wiki,tier=db"), "pods")).toBe(false);
  });

  it("requires both the selector and the text to match", () => {
    expect(matchesFilter(pod, parseFilter("app=wiki djpwx"), "pods")).toBe(true);
    expect(matchesFilter(pod, parseFilter("app=wiki zzz"), "pods")).toBe(false);
  });

  it("rejects a row with no labels when a selector is present", () => {
    const svc = row({ name: "wiki", labels: undefined });
    expect(matchesFilter(svc, parseFilter("app=wiki"), "services")).toBe(false);
  });

  it("matches everything when the filter is empty", () => {
    expect(matchesFilter(pod, parseFilter(""), "pods")).toBe(true);
  });

  it("matches events across their cells, since the event name is opaque", () => {
    const ev = row({
      name: "wiki.17c3f",
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
    expect(selectorFilter({ tier: "web", app: "wiki" })).toBe("app=wiki,tier=web");
  });

  it("round-trips back through parseFilter", () => {
    const s = selectorFilter({ app: "wiki", tier: "web" });
    expect(parseFilter(s).labels).toEqual([
      ["app", "wiki"],
      ["tier", "web"],
    ]);
  });

  it("is empty for no labels", () => {
    expect(selectorFilter({})).toBe("");
  });
});
