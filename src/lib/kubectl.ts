/**
 * kubectl command previews (B88, absorbing v5 B64): every action the app takes
 * has a kubectl equivalent; showing it on the confirmation builds trust and
 * teaches kubectl. The command is constructed from the action's parameters, not
 * reverse-engineered from the API call, so it matches what a user would type.
 */

import type { ActionId } from "./actions";
import type { Row } from "../providers/types";

/** The kubectl resource name for a kind: singular for built-ins (kubectl accepts
 *  `deployment/web`), the CRD plural for custom kinds ("group/plural" ids). */
export function kubectlResource(kind: string): string {
  if (kind.includes("/")) return kind.slice(kind.indexOf("/") + 1);
  // All built-in ids are plurals; "ingresses" is the only irregular singular.
  if (kind === "ingresses") return "ingress";
  return kind.replace(/s$/, "");
}

/** Build the kubectl command(s) for an action — one per row for bulk actions. */
export function kubectlCommand(
  id: ActionId,
  kind: string,
  rows: Row[],
  params?: { replicas?: number; port?: number },
): string[] {
  const one = (r: Row): string => {
    const ns = r.namespace ? ` -n ${r.namespace}` : "";
    const resource = kubectlResource(kind);
    const name = r.name;
    switch (id) {
      case "scale":
        return `kubectl scale ${resource}/${name}${ns} --replicas=${params?.replicas ?? 1}`;
      case "delete":
        return `kubectl delete ${resource}/${name}${ns}`;
      case "drain":
        // k7s always skips DaemonSet pods and imposes no emptyDir guard — the
        // flags that make `kubectl drain` behave the same way.
        return `kubectl drain ${name} --ignore-daemonsets --delete-emptydir-data`;
      case "cordon":
        return `kubectl cordon ${name}`;
      case "uncordon":
        return `kubectl uncordon ${name}`;
      case "restart":
        return kind === "pods"
          ? `kubectl delete pod/${name}${ns}` // the controller recreates it
          : `kubectl rollout restart ${resource}/${name}${ns}`;
      case "suspend":
        return `kubectl patch cronjob/${name}${ns} -p '{"spec":{"suspend":true}}'`;
      case "resume":
        return `kubectl patch cronjob/${name}${ns} -p '{"spec":{"suspend":false}}'`;
      case "run-now":
        return `kubectl create job ${name}-manual --from=cronjob/${name}${ns}`;
      case "retry":
        return `kubectl delete job/${name}${ns} && kubectl create job ${name}-retry${ns}`;
      case "forward":
        return `kubectl port-forward ${resource}/${name}${ns} :${params?.port ?? 8080}`;
      case "uninstall":
        return `helm uninstall ${name} -n ${r.namespace ?? "default"}`;
      default:
        return `kubectl ${id} ${resource}/${name}${ns}`;
    }
  };
  return rows.map(one);
}

/** Copy text to the clipboard (shared; silent on failure — the caller shows the
 *  command either way). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard unavailable — the command stays visible for manual copying
  }
}
