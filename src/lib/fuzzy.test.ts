/**
 * Tests for the palette's fuzzy scorer (B28).
 *
 * These are mostly *ranking* tests, written against real names from freya. A
 * matcher that merely matches is easy; one that puts the right thing first is
 * the whole feature, so the assertions compare candidates against each other
 * rather than checking absolute scores (which are only meaningful within a query).
 */

import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";

/** Rank candidates best-first for a query, dropping non-matches. */
function rank(query: string, candidates: string[]): string[] {
  return candidates
    .map((c) => ({ c, m: fuzzyMatch(query, c) }))
    .filter((x) => x.m !== null)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => x.c);
}

describe("fuzzyMatch", () => {
  it("matches a subsequence, not just a substring", () => {
    expect(fuzzyMatch("wk", "wiki")).not.toBeNull();
    expect(fuzzyMatch("wiki", "wiki-6b6d775f4-djpwx")).not.toBeNull();
  });

  it("rejects what isn't a subsequence", () => {
    expect(fuzzyMatch("xyz", "wiki")).toBeNull();
    expect(fuzzyMatch("iw", "wiki"), "order matters").toBeNull();
    expect(fuzzyMatch("wikix", "wiki"), "longer than target").toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("WIKI", "wiki-6b6")).not.toBeNull();
    expect(fuzzyMatch("ingressroute", "IngressRoute")).not.toBeNull();
  });

  it("matches everything on an empty query, so callers get the default list", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  // ---- ranking: the part that decides whether the palette is usable ----

  it("ranks a name that starts with the query above one that merely contains it", () => {
    // The backlog's own acceptance case.
    const out = rank("wik", ["svclb-cb8-wiki-nextra-ab930ae9", "wiki-6b6d775f4-djpwx"]);
    expect(out[0]).toBe("wiki-6b6d775f4-djpwx");
  });

  it("prefers a consecutive run over scattered characters", () => {
    // Greedy left-to-right would take the 'a' at index 0 of argocd- and score a
    // scattered match; the run in "application" is what was meant.
    const out = rank("app", ["argocd-application-controller-0", "argocd-repo-server"]);
    expect(out[0]).toBe("argocd-application-controller-0");
  });

  it("prefers matches at word boundaries", () => {
    // "rs" after hyphens beats the same letters buried mid-word.
    const out = rank("rs", ["arc-gha-rs-controller", "argocd-server"]);
    expect(out[0]).toBe("arc-gha-rs-controller");
  });

  it("finds camelCase humps, so a Kind name matches its parts", () => {
    const m = fuzzyMatch("ir", "IngressRoute");
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 7]);
  });

  it("ranks an exact match above every partial", () => {
    const out = rank("traefik", ["traefik-crd", "traefik", "svclb-traefik-7c19608e"]);
    expect(out[0]).toBe("traefik");
  });

  it("ranks a shorter, tighter name above a longer one that also matches", () => {
    const out = rank("redis", ["argocd-redis-6f6867546c-7x7gb", "csearch-redis-6bb8d4fb9-kcp4z", "redis"]);
    expect(out[0]).toBe("redis");
  });

  it("finds a pod by its namespace/name pair", () => {
    // The palette searches "ns/name" too, so this shape must score sensibly.
    const out = rank("argowiki", ["argocd/wiki-thing", "other/argowiki"]);
    expect(out.length).toBe(2);
    // The contiguous run wins over the split-across-slash match.
    expect(out[0]).toBe("other/argowiki");
  });

  // ---- highlighting ----

  it("reports the matched positions so they can be highlighted", () => {
    const m = fuzzyMatch("wiki", "wiki-6b6");
    expect(m!.indices).toEqual([0, 1, 2, 3]);
  });

  it("reports positions of a run that starts mid-name", () => {
    const m = fuzzyMatch("wiki", "svclb-wiki-x");
    expect(m!.indices).toEqual([6, 7, 8, 9]);
  });

  it("reports one index per query character, ascending, in range", () => {
    const target = "argocd-application-controller-0";
    const m = fuzzyMatch("appctl", target)!;
    expect(m.indices.length).toBe(6);
    for (let i = 1; i < m.indices.length; i++) {
      expect(m.indices[i]).toBeGreaterThan(m.indices[i - 1]);
    }
    // Every reported index must actually hold its query character.
    const got = m.indices.map((i) => target[i].toLowerCase()).join("");
    expect(got).toBe("appctl");
  });

  it("survives a pathological target without hanging", () => {
    const huge = "a".repeat(5000);
    expect(fuzzyMatch("aaa", huge)).toBeNull();
  });
});
