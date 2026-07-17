/**
 * Tests for the log view options (B29).
 */

import { describe, expect, it } from "vitest";
import { exportFilename, hasPrevious, sinceSeconds, SINCE_OPTIONS } from "./logview";

describe("sinceSeconds", () => {
  it("maps each window to its seconds", () => {
    expect(sinceSeconds("5m")).toBe(300);
    expect(sinceSeconds("1h")).toBe(3600);
    expect(sinceSeconds("24h")).toBe(86400);
  });

  // The API reads sinceSeconds=0 as a real, empty window — "no bound" has to be
  // the absence of the field, not a zero.
  it("returns undefined for 'all', never zero", () => {
    expect(sinceSeconds("all")).toBeUndefined();
  });

  it("covers every option", () => {
    for (const o of SINCE_OPTIONS) {
      const s = sinceSeconds(o);
      expect(o === "all" ? s === undefined : typeof s === "number").toBe(true);
    }
  });

  it("defaults to the widest, so the tab behaves as it did before", () => {
    expect(SINCE_OPTIONS[0]).toBe("all");
  });
});

describe("hasPrevious", () => {
  it("is true once a container has restarted", () => {
    expect(hasPrevious(1)).toBe(true);
    expect(hasPrevious(3311)).toBe(true);
  });

  // Asking for a previous generation that never existed is a 400, so the control
  // shouldn't be there to press.
  it("is false for a pod that has never restarted", () => {
    expect(hasPrevious(0)).toBe(false);
    expect(hasPrevious(undefined)).toBe(false);
  });
});

describe("exportFilename", () => {
  it("names the pod and container", () => {
    expect(exportFilename("wiki-6b6d775f4-djpwx", "wiki", false)).toBe(
      "wiki-6b6d775f4-djpwx.wiki.log",
    );
  });

  it("marks a previous export, so the two don't overwrite each other", () => {
    expect(exportFilename("wiki-6b6d775f4-djpwx", "wiki", true)).toBe(
      "wiki-6b6d775f4-djpwx.wiki.previous.log",
    );
  });

  it("names the all-containers view", () => {
    expect(exportFilename("api-x", "", false)).toBe("api-x.all.log");
  });
});
