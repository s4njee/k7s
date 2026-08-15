/**
 * kubectl command previews (B88, v5 B64): the acceptance strings — scale's exact
 * command, drain's flags matching the app's behavior, bulk as one per row — and
 * the resource-name mapping (singular built-ins, CRD plurals).
 */

import { describe, expect, it } from "vitest";
import { kubectlCommand, kubectlResource } from "./kubectl";
import type { Row } from "../providers/types";

const row = (name: string, namespace?: string): Row => ({
  uid: `${namespace ?? "x"}/${name}`,
  name,
  namespace,
  cells: [],
});

describe("kubectlResource", () => {
  it("singularizes built-in plurals", () => {
    expect(kubectlResource("deployments")).toBe("deployment");
    expect(kubectlResource("pods")).toBe("pod");
    expect(kubectlResource("ingresses")).toBe("ingress");
    expect(kubectlResource("services")).toBe("service");
    expect(kubectlResource("horizontalpodautoscalers")).toBe("horizontalpodautoscaler");
  });

  it("uses the CRD plural for custom kinds", () => {
    expect(kubectlResource("argoproj.io/applications")).toBe("applications");
  });
});

describe("kubectlCommand", () => {
  it("scales a Deployment with the exact acceptance command", () => {
    expect(kubectlCommand("scale", "deployments", [row("web", "default")], { replicas: 3 })).toEqual([
      "kubectl scale deployment/web -n default --replicas=3",
    ]);
  });

  it("drains with the flags matching the app's behavior", () => {
    expect(kubectlCommand("drain", "nodes", [row("node-01")])).toEqual([
      "kubectl drain node-01 --ignore-daemonsets --delete-emptydir-data",
    ]);
  });

  it("restarts a pod as a delete (the controller recreates it) and a rollout as rollout restart", () => {
    expect(kubectlCommand("restart", "pods", [row("web-abc", "prod")])).toEqual([
      "kubectl delete pod/web-abc -n prod",
    ]);
    expect(kubectlCommand("restart", "deployments", [row("web", "prod")])).toEqual([
      "kubectl rollout restart deployment/web -n prod",
    ]);
  });

  it("cordons/uncordons a node", () => {
    expect(kubectlCommand("cordon", "nodes", [row("node-01")])).toEqual(["kubectl cordon node-01"]);
    expect(kubectlCommand("uncordon", "nodes", [row("node-01")])).toEqual(["kubectl uncordon node-01"]);
  });

  it("bulk actions produce one command per resource", () => {
    const cmds = kubectlCommand("delete", "pods", [row("a", "prod"), row("b", "prod")]);
    expect(cmds).toEqual(["kubectl delete pod/a -n prod", "kubectl delete pod/b -n prod"]);
  });

  it("suspend/resume patch the cronjob's suspend field", () => {
    expect(kubectlCommand("suspend", "cronjobs", [row("report-gen", "prod")])).toEqual([
      `kubectl patch cronjob/report-gen -n prod -p '{"spec":{"suspend":true}}'`,
    ]);
  });
});
