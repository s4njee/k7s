//! Restarting workloads and pods (B34).
//!
//! Kubernetes has no "restart" verb; there are two distinct mechanisms, and which
//! one applies depends on the kind:
//!
//!   - **A pod** is restarted by *deleting* it and letting its controller recreate
//!     a fresh one. This only makes sense when a controller owns it — deleting a
//!     bare, hand-created pod just destroys it, so [`has_controller`] gates that.
//!
//!   - **A workload** (Deployment/StatefulSet/DaemonSet) is restarted the way
//!     `kubectl rollout restart` does it: stamp the pod *template* with a
//!     `restartedAt` annotation. That changes the template hash, which the
//!     controller sees as a spec change and rolls every pod through the normal
//!     update strategy — surge/maxUnavailable respected, no downtime beyond what
//!     the workload already tolerates. The annotation *is* the API; there is no
//!     dedicated endpoint.
//!
//! Both are one merge-patch or one delete, so the logic here is just the two pure
//! decisions (is there a controller / what does the patch look like) that the
//! commands wrap. Keeping them pure is what lets the patch shape be pinned by a
//! test rather than only ever exercised against a live cluster.

use k8s_openapi::api::core::v1::Pod;

/// Kinds that carry a pod template and can therefore be rollout-restarted. A
/// Job's template is immutable and a CronJob restarts by its schedule, so neither
/// belongs here — the set matches `kubectl rollout restart`'s.
pub const ROLLOUT_KINDS: [&str; 3] = ["deployments", "statefulsets", "daemonsets"];

/// Whether `kind` (a built-in table id) supports rollout restart.
pub fn is_rollout_kind(kind: &str) -> bool {
    ROLLOUT_KINDS.contains(&kind)
}

/// Whether a controller owns this pod and would recreate it after a delete.
///
/// A pod created by hand has no controller owner reference; "restarting" it by
/// deleting it would simply remove it, which is a delete, not a restart. The UI
/// offers Delete for that case instead.
pub fn has_controller(pod: &Pod) -> bool {
    pod.metadata
        .owner_references
        .iter()
        .flatten()
        .any(|o| o.controller == Some(true))
}

/// The merge patch `kubectl rollout restart` applies: a `restartedAt` annotation
/// on the pod template, set to `now` (an RFC3339 timestamp). Written as a merge
/// patch so it adds the annotation without touching the rest of the template.
pub fn restart_patch(now: &str) -> serde_json::Value {
    serde_json::json!({
        "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now
        }}}}
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod_json(v: serde_json::Value) -> Pod {
        serde_json::from_value(v).unwrap()
    }

    /// A Deployment-managed pod (via its ReplicaSet) has a controller — restart is
    /// a safe delete-and-recreate.
    #[test]
    fn controller_owned_pod_has_controller() {
        let p = pod_json(json!({
            "metadata": { "name": "api", "namespace": "prod",
                          "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet",
                                                "name": "api-1", "uid": "u1", "controller": true }] },
        }));
        assert!(has_controller(&p));
    }

    /// A hand-created pod has no owner references at all — restarting it would just
    /// delete it, so the command refuses.
    #[test]
    fn bare_pod_has_no_controller() {
        let p = pod_json(json!({ "metadata": { "name": "debug", "namespace": "default" } }));
        assert!(!has_controller(&p));
    }

    /// An owner reference that isn't the *controller* (controller absent or false)
    /// doesn't count — only the managing controller recreates the pod.
    #[test]
    fn non_controller_owner_does_not_count() {
        let p = pod_json(json!({
            "metadata": { "name": "x", "namespace": "default",
                          "ownerReferences": [{ "apiVersion": "v1", "kind": "Pod",
                                                "name": "owner", "uid": "u9" }] },
        }));
        assert!(!has_controller(&p));
    }

    /// The rollout patch is exactly the template-annotation shape kubectl writes —
    /// under spec.template.metadata, never spec.metadata, or it would annotate the
    /// workload without rolling its pods.
    #[test]
    fn restart_patch_stamps_the_template() {
        let patch = restart_patch("2026-07-17T12:00:00+00:00");
        assert_eq!(
            patch,
            json!({
                "spec": { "template": { "metadata": { "annotations": {
                    "kubectl.kubernetes.io/restartedAt": "2026-07-17T12:00:00+00:00"
                }}}}
            })
        );
    }

    /// Only pod-template controllers roll; Jobs/CronJobs and everything else don't.
    #[test]
    fn rollout_kinds_are_the_template_controllers() {
        assert!(is_rollout_kind("deployments"));
        assert!(is_rollout_kind("statefulsets"));
        assert!(is_rollout_kind("daemonsets"));
        assert!(!is_rollout_kind("jobs"));
        assert!(!is_rollout_kind("cronjobs"));
        assert!(!is_rollout_kind("pods"));
    }
}
