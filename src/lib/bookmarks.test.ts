/**
 * Tests for the bookmark key (B56): the stable identity the sidebar, the toggle
 * and the palette boost all key on.
 */

import { describe, expect, it } from "vitest";
import { bookmarkKey, sameBookmark, type Bookmark } from "./bookmarks";

const b = (kind: string, name: string, namespace?: string): Bookmark => ({
  kind,
  name,
  namespace,
});

describe("bookmarkKey", () => {
  it("is the palette's object identity: kind:namespace/name", () => {
    expect(bookmarkKey(b("pods", "wiki-abc", "prod"))).toBe("pods:prod/wiki-abc");
    // Cluster-scoped kinds have no namespace segment.
    expect(bookmarkKey(b("nodes", "freya-01"))).toBe("nodes:/freya-01");
  });

  it("distinguishes the same name in different namespaces", () => {
    expect(bookmarkKey(b("pods", "api", "prod"))).not.toBe(bookmarkKey(b("pods", "api", "staging")));
  });
});

describe("sameBookmark", () => {
  it("is true for the same kind/ns/name, regardless of field order", () => {
    expect(sameBookmark(b("pods", "wiki", "prod"), { kind: "pods", name: "wiki", namespace: "prod" })).toBe(true);
  });

  it("is false when any part differs", () => {
    expect(sameBookmark(b("pods", "wiki", "prod"), b("pods", "wiki", "staging"))).toBe(false);
    expect(sameBookmark(b("pods", "wiki", "prod"), b("deployments", "wiki", "prod"))).toBe(false);
    expect(sameBookmark(b("pods", "wiki", "prod"), b("pods", "other", "prod"))).toBe(false);
  });
});
