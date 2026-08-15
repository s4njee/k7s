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

  it("matches problems across their cells — the reason is where you'd search (B32)", () => {
    const prob = row({
      name: "heimdall",
      cells: [
        { text: "error", tone: "err" },
        { text: "Pod", tone: "primary" },
        { text: "heimdall", tone: "secondary" },
        { text: "CrashLoopBackOff", tone: "secondary" },
      ],
    });
    expect(matchesFilter(prob, parseFilter("crashloop"), "problems")).toBe(true);
    expect(matchesFilter(prob, parseFilter("postgres"), "problems")).toBe(false);
  });
});

describe("matchesFilter — column-name matching (B60)", () => {
  // The pods column set, as kindMeta reports it; the last cell is STATUS.
  const POD_COLUMNS = ["NAME", "NAMESPACE", "READY", "RESTARTS", "CPU", "MEM", "AGE", "STATUS"];
  const crashLoopPod = row({
    name: "heimdall-auth-6b8c9d5f7-qq3rt",
    labels: { app: "heimdall-auth" },
    cells: [
      { text: "heimdall-auth-6b8c9d5f7-qq3rt", tone: "primary" },
      { text: "prod", tone: "muted" },
      { text: "1/2", tone: "warn" },
      { text: "14", tone: "err" },
      { text: "45m", tone: "secondary" },
      { text: "203Mi", tone: "secondary" },
      { text: "2h14m", tone: "muted" },
      { text: "CrashLoopBackOff", tone: "err" },
    ],
  });

  it("status=… matches the STATUS cell exactly", () => {
    expect(matchesFilter(crashLoopPod, parseFilter("status=CrashLoopBackOff"), "pods", POD_COLUMNS)).toBe(true);
    expect(matchesFilter(crashLoopPod, parseFilter("status=Running"), "pods", POD_COLUMNS)).toBe(false);
  });

  it("a | value is an OR of alternatives", () => {
    expect(matchesFilter(crashLoopPod, parseFilter("status=Running|CrashLoopBackOff"), "pods", POD_COLUMNS)).toBe(true);
    expect(matchesFilter(crashLoopPod, parseFilter("status=Running|Failed"), "pods", POD_COLUMNS)).toBe(false);
  });

  it("is case-insensitive in both key and value", () => {
    expect(matchesFilter(crashLoopPod, parseFilter("STATUS=crashloopbackoff"), "pods", POD_COLUMNS)).toBe(true);
  });

  it("a key that isn't a column still matches labels", () => {
    expect(matchesFilter(crashLoopPod, parseFilter("app=heimdall-auth"), "pods", POD_COLUMNS)).toBe(true);
    expect(matchesFilter(crashLoopPod, parseFilter("app=other"), "pods", POD_COLUMNS)).toBe(false);
  });

  it("a column match works on kinds without labels (events type=Warning)", () => {
    const ev = row({
      name: "x.17c3f",
      cells: [
        { text: "Warning", tone: "err" },
        { text: "FailedMount", tone: "primary" },
      ],
    });
    expect(matchesFilter(ev, parseFilter("type=Warning"), "events", ["TYPE", "REASON"])).toBe(true);
    expect(matchesFilter(ev, parseFilter("type=Normal"), "events", ["TYPE", "REASON"])).toBe(false);
  });

  it("without columns, key=value stays a label selector (back-compat)", () => {
    // "status" isn't a label, so a row with labels rejects it — the old behaviour.
    expect(matchesFilter(crashLoopPod, parseFilter("status=CrashLoopBackOff"), "pods")).toBe(false);
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
