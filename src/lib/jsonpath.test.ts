/**
 * The restricted JSONPath subset (B30), now shared by printer columns and B87
 * custom columns: dotted fields + [n] indices, braces/$ tolerated, everything
 * else unsupported → "—".
 */

import { describe, expect, it } from "vitest";
import { evalJsonPath, jsonpathCell } from "./jsonpath";

const OBJ = {
  metadata: { name: "wiki", labels: { app: "wiki", tier: "web" }, annotations: { owner: "team-a" } },
  spec: { replicas: 2, containers: [{ name: "app", ports: [{ containerPort: 8080 }] }] },
};

describe("evalJsonPath (restricted subset)", () => {
  it("walks dotted fields", () => {
    expect(evalJsonPath(".metadata.name", OBJ)).toBe("wiki");
    expect(evalJsonPath(".spec.replicas", OBJ)).toBe(2);
  });

  it("indexes arrays with [n]", () => {
    expect(evalJsonPath(".spec.containers[0].name", OBJ)).toBe("app");
    expect(evalJsonPath(".spec.containers[0].ports[0].containerPort", OBJ)).toBe(8080);
  });

  it("tolerates the braced and $-prefixed forms", () => {
    expect(evalJsonPath("{.metadata.name}", OBJ)).toBe("wiki");
    expect(evalJsonPath("$.metadata.name", OBJ)).toBe("wiki");
  });

  it("resolves a label or annotation key through its map (dot-free keys only)", () => {
    expect(evalJsonPath(".metadata.labels.app", OBJ)).toBe("wiki");
    expect(evalJsonPath(".metadata.annotations.owner", OBJ)).toBe("team-a");
  });

  it("returns undefined for a missing path, a null, or a subtree", () => {
    expect(evalJsonPath(".metadata.nope", OBJ)).toBeUndefined();
    expect(evalJsonPath(".spec.containers", OBJ)).toBeUndefined(); // array subtree
    expect(evalJsonPath(".metadata.labels.missing", OBJ)).toBeUndefined();
  });

  it("returns undefined for syntax outside the subset", () => {
    expect(evalJsonPath(".spec.containers[*].name", OBJ)).toBeUndefined();
    expect(evalJsonPath('.metadata.labels["app"]', OBJ)).toBeUndefined();
    expect(evalJsonPath("$[?(.a)]", OBJ)).toBeUndefined();
  });
});

describe("jsonpathCell", () => {
  it("renders a scalar as secondary text", () => {
    expect(jsonpathCell(".metadata.name", OBJ)).toEqual({ text: "wiki", tone: "secondary" });
  });

  it("renders a missing or unsupported path as —", () => {
    expect(jsonpathCell(".metadata.nope", OBJ)).toEqual({ text: "—", tone: "secondary" });
    expect(jsonpathCell(".spec.containers[*].name", OBJ)).toEqual({ text: "—", tone: "secondary" });
  });
});
