/**
 * Tests for the kind registry helpers that resolve built-in vs custom (CRD-backed)
 * kinds (B15). The built-in column contract itself is verified against the backend
 * mappers by the Rust tests; these cover the runtime lookups the UI depends on.
 */

import { describe, expect, it } from "vitest";
import { isClusterScoped, isCustomKind, kindMeta } from "./kinds";
import type { CustomKind } from "../providers/types";

const APPS: CustomKind = {
  id: "argoproj.io/applications",
  group: "argoproj.io",
  version: "v1alpha1",
  kind: "Application",
  plural: "applications",
  namespaced: true,
};

const ISSUERS: CustomKind = {
  id: "cert-manager.io/clusterissuers",
  group: "cert-manager.io",
  version: "v1",
  kind: "ClusterIssuer",
  plural: "clusterissuers",
  namespaced: false,
};

const CUSTOM = [APPS, ISSUERS];

describe("isCustomKind", () => {
  it("distinguishes custom ids by their slash", () => {
    expect(isCustomKind("argoproj.io/applications")).toBe(true);
    expect(isCustomKind("pods")).toBe(false);
    expect(isCustomKind("events")).toBe(false);
  });
});

describe("kindMeta", () => {
  it("returns the static entry for a built-in kind", () => {
    expect(kindMeta("pods", CUSTOM)?.label).toBe("Pods");
    expect(kindMeta("pods", CUSTOM)?.columns[0]).toBe("NAME");
  });

  it("labels a custom kind by its Kind name, not its plural", () => {
    expect(kindMeta("argoproj.io/applications", CUSTOM)?.label).toBe("Application");
  });

  it("gives namespaced custom kinds a NAMESPACE column", () => {
    expect(kindMeta("argoproj.io/applications", CUSTOM)?.columns).toEqual([
      "NAME",
      "NAMESPACE",
      "AGE",
    ]);
  });

  it("omits NAMESPACE for cluster-scoped custom kinds", () => {
    expect(kindMeta("cert-manager.io/clusterissuers", CUSTOM)?.columns).toEqual(["NAME", "AGE"]);
  });

  it("puts custom kinds in the custom nav group", () => {
    expect(kindMeta("argoproj.io/applications", CUSTOM)?.group).toBe("custom");
  });

  it("returns undefined for a custom kind this cluster doesn't have", () => {
    // e.g. a nav restored from prefs after switching to a cluster without that CRD.
    expect(kindMeta("traefik.io/ingressroutes", CUSTOM)).toBeUndefined();
  });
});

describe("isClusterScoped", () => {
  it("knows the built-in cluster-scoped kinds", () => {
    expect(isClusterScoped("nodes", CUSTOM)).toBe(true);
    expect(isClusterScoped("namespaces", CUSTOM)).toBe(true);
    expect(isClusterScoped("pods", CUSTOM)).toBe(false);
  });

  it("treats Events as namespaced despite its Cluster nav group", () => {
    expect(isClusterScoped("events", CUSTOM)).toBe(false);
  });

  it("follows the CRD's scope", () => {
    expect(isClusterScoped("cert-manager.io/clusterissuers", CUSTOM)).toBe(true);
    expect(isClusterScoped("argoproj.io/applications", CUSTOM)).toBe(false);
  });
});
