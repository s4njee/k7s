/**
 * Tests for the kind registry helpers that resolve built-in vs custom (CRD-backed)
 * kinds (B15). The built-in column contract itself is verified against the backend
 * mappers by the Rust tests; these cover the runtime lookups the UI depends on.
 */

import { describe, expect, it } from "vitest";
import { isClusterScoped, isCustomKind, kindMeta, navIdForKind, KINDS_WITH_PROPERTIES,
  tabsFor,
} from "./kinds";
import { mockProperties } from "../providers/mock/properties";
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

describe("KINDS_WITH_PROPERTIES", () => {
  // The set decides whether the tab is offered; a kind listed without a gatherer
  // would render a tab that only ever errors ("no dead tab", B18).
  it("every listed kind actually has a gatherer", () => {
    for (const kind of KINDS_WITH_PROPERTIES) {
      expect(mockProperties({ kind, namespace: "prod", name: "x" }), kind).not.toBeNull();
    }
  });

  it("kinds without a gatherer are not listed", () => {
    expect(KINDS_WITH_PROPERTIES.has("configmaps")).toBe(false);
    expect(KINDS_WITH_PROPERTIES.has("events")).toBe(false);
    expect(mockProperties({ kind: "configmaps", namespace: "prod", name: "x" })).toBeNull();
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

describe("navIdForKind (B33: event → object)", () => {
  it("maps a built-in Kind to its nav id, apiVersion irrelevant", () => {
    expect(navIdForKind("Pod", "v1", CUSTOM)).toBe("pods");
    expect(navIdForKind("Deployment", "apps/v1", CUSTOM)).toBe("deployments");
    expect(navIdForKind("Node", "v1", CUSTOM)).toBe("nodes");
  });

  it("resolves a CRD by Kind AND group", () => {
    expect(navIdForKind("Application", "argoproj.io/v1alpha1", CUSTOM)).toBe(
      "argoproj.io/applications",
    );
  });

  it("returns null for the right Kind in the wrong group", () => {
    // A different vendor's CRD that happens to also be named Application.
    expect(navIdForKind("Application", "example.com/v1", CUSTOM)).toBeNull();
  });

  it("returns null for a kind we don't list, so the row stays inert", () => {
    // Endpoints and PriorityClass still have no table. (ReplicaSet and
    // ServiceAccount used to be the examples here; both since got one.)
    expect(navIdForKind("Endpoints", "v1", CUSTOM)).toBeNull();
    expect(navIdForKind("PriorityClass", "scheduling.k8s.io/v1", CUSTOM)).toBeNull();
  });

  it("built-ins win even when a CRD isn't loaded", () => {
    expect(navIdForKind("Pod", "v1", [])).toBe("pods");
    expect(navIdForKind("Application", "argoproj.io/v1alpha1", [])).toBeNull();
  });
});

describe("storage kinds (PVs / PVCs)", () => {
  it("puts claims and volumes in the Storage group", () => {
    expect(kindMeta("persistentvolumeclaims", CUSTOM)?.group).toBe("storage");
    expect(kindMeta("persistentvolumes", CUSTOM)?.group).toBe("storage");
  });

  // The column contract: these arrays must match the Rust mappers' cell order
  // (map_pvc / map_pv in src-tauri/src/kube/mappers.rs).
  it("declares the claim columns, with NAMESPACE second", () => {
    expect(kindMeta("persistentvolumeclaims", CUSTOM)?.columns).toEqual([
      "NAME", "NAMESPACE", "STATUS", "VOLUME", "CAPACITY", "ACCESS", "CLASS", "AGE",
    ]);
  });

  it("declares the volume columns with no NAMESPACE — PVs are cluster-scoped", () => {
    const cols = kindMeta("persistentvolumes", CUSTOM)?.columns ?? [];
    expect(cols).toEqual([
      "NAME", "CAPACITY", "ACCESS", "RECLAIM", "STATUS", "CLAIM", "CLASS", "AGE",
    ]);
    expect(cols).not.toContain("NAMESPACE");
  });

  it("scopes PVs cluster-wide but keeps PVCs namespaced", () => {
    expect(isClusterScoped("persistentvolumes", CUSTOM)).toBe(true);
    expect(isClusterScoped("persistentvolumeclaims", CUSTOM)).toBe(false);
  });

  // So a FailedBinding event on a claim is clickable (B33).
  it("resolves the Kinds for event click-through", () => {
    expect(navIdForKind("PersistentVolumeClaim", "v1", CUSTOM)).toBe("persistentvolumeclaims");
    expect(navIdForKind("PersistentVolume", "v1", CUSTOM)).toBe("persistentvolumes");
  });
});

describe("ReplicaSets and StorageClasses (B40)", () => {
  it("files ReplicaSets under Workloads and StorageClasses under Storage", () => {
    expect(kindMeta("replicasets", CUSTOM)?.group).toBe("workloads");
    expect(kindMeta("storageclasses", CUSTOM)?.group).toBe("storage");
  });

  // Column contract — must match map_replicaset / map_storageclass in mappers.rs.
  it("declares the ReplicaSet columns", () => {
    expect(kindMeta("replicasets", CUSTOM)?.columns).toEqual([
      "NAME", "NAMESPACE", "DESIRED", "CURRENT", "READY", "AGE",
    ]);
  });

  it("declares the StorageClass columns, with no NAMESPACE", () => {
    const cols = kindMeta("storageclasses", CUSTOM)?.columns ?? [];
    expect(cols).toEqual(["NAME", "PROVISIONER", "RECLAIM", "BINDING", "EXPANSION", "AGE"]);
    expect(cols).not.toContain("NAMESPACE");
  });

  it("scopes StorageClasses cluster-wide, ReplicaSets namespaced", () => {
    expect(isClusterScoped("storageclasses", CUSTOM)).toBe(true);
    expect(isClusterScoped("replicasets", CUSTOM)).toBe(false);
  });

  // The gap that motivated this: these Kinds are referenced all over the
  // properties panel and used to resolve to nothing.
  it("resolves the Kinds that used to be dead ends", () => {
    expect(navIdForKind("ReplicaSet", "apps/v1", CUSTOM)).toBe("replicasets");
    expect(navIdForKind("StorageClass", "storage.k8s.io/v1", CUSTOM)).toBe("storageclasses");
  });
});

describe("ServiceAccounts", () => {
  it("sits in Config, namespaced, with kubectl's columns", () => {
    expect(kindMeta("serviceaccounts", CUSTOM)?.group).toBe("config");
    expect(kindMeta("serviceaccounts", CUSTOM)?.columns).toEqual([
      "NAME", "NAMESPACE", "SECRETS", "AGE",
    ]);
    expect(isClusterScoped("serviceaccounts", CUSTOM)).toBe(false);
  });

  // So a pod's "service account" field links, instead of dead-ending.
  it("resolves the Kind", () => {
    expect(navIdForKind("ServiceAccount", "v1", CUSTOM)).toBe("serviceaccounts");
  });
});

describe("tabsFor", () => {
  /**
   * Logs needs a container to read from; a node has none. Shell, by contrast, is
   * offered for nodes because B53 gives it a different mechanism (a privileged
   * debug pod) behind the same tab.
   */
  it("offers Shell but not Logs on a node", () => {
    const tabs = tabsFor("nodes", false);
    expect(tabs).toContain("shell");
    expect(tabs).not.toContain("logs");
  });

  it("still offers both on a pod", () => {
    const tabs = tabsFor("pods", true);
    expect(tabs).toContain("shell");
    expect(tabs).toContain("logs");
  });

  /** Nothing else grew a shell tab by accident. */
  it("offers Shell nowhere else", () => {
    for (const kind of ["deployments", "services", "configmaps", "helm", "namespaces"]) {
      expect(tabsFor(kind, false), kind).not.toContain("shell");
    }
  });
});
