/**
 * Tests for the B74-L error helpers: the typed envelope normalizes into a safe
 * message and a specific next action, never a raw backend string or `[object
 * Object]`.
 */

import { describe, expect, it } from "vitest";
import { errDisplay, errEnvelope, errMsg } from "./errors";

const envelope = {
  code: "forbidden",
  message: "permission denied — the current identity can't do this here",
  retryable: false,
  action: {
    label: "Check permissions",
    hint: "ask your cluster admin for the missing RBAC role, or use a different context.",
  },
  kind: "secrets",
  detail: 'Api(ErrorResponse { message: "forbidden", code: 403 })',
};

describe("errMsg / errEnvelope (B74-L)", () => {
  it("reads the safe message from an envelope", () => {
    expect(errMsg(envelope)).toBe(envelope.message);
    // The raw detail never leaks into the safe message.
    expect(errMsg(envelope)).not.toContain("Api(ErrorResponse");
  });

  it("falls back to Error.message and plain strings", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg("raw string")).toBe("raw string");
    expect(errMsg(null)).toBe("null"); // never throws
  });

  it("extracts the envelope (or null) for action rendering", () => {
    expect(errEnvelope(envelope)).toEqual(envelope);
    expect(errEnvelope(new Error("x"))).toBeNull();
    expect(errEnvelope("nope")).toBeNull();
  });

  it("errDisplay appends the specific next action, keeping raw detail out", () => {
    const d = errDisplay(envelope);
    expect(d).toContain(envelope.message);
    expect(d).toContain("ask your cluster admin");
    expect(d).not.toContain("Api(ErrorResponse");
  });
});
