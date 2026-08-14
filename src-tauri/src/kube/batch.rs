//! The batch kinds' verbs (B47): CronJob suspend/resume and run-now, and Job
//! retry — mirroring `kubectl create job --from=…`'s exact mechanics.
//!
//! Both run-now and retry build a new Job by copying a template and stripping
//! the fields the Job controller owns: the selector (it assigns its own) and
//! the `controller-uid`/`job-name` labels and batch tracking annotations on the
//! pod template. Carrying those over would make the new Job adopt the old one's
//! identity — the retried Job must be owned by nothing, so it can be deleted on
//! its own. The strip is pure so the copy is pinned by a test.

use k8s_openapi::api::batch::v1::{CronJob, Job, JobSpec};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde_json::Value;

/// Keys the Job controller stamps on a Job's pod template.
const MANAGED_LABELS: [&str; 2] = ["controller-uid", "job-name"];
const MANAGED_ANNOTATIONS: [&str; 2] = [
    "batch.kubernetes.io/job-tracking",
    "batch.kubernetes.io/controller-uid",
];

/// The merge patch `kubectl` uses to suspend or resume a CronJob.
pub fn suspend_patch(suspended: bool) -> Value {
    serde_json::json!({ "spec": { "suspend": suspended } })
}

/// A Job that runs a CronJob's jobTemplate now (B47) — the exact mechanic of
/// `kubectl create job --from=cronjob/x` — named `manual-<cronjob>-<seq>`.
pub fn manual_job(cronjob: &CronJob, seq: u64) -> Option<Job> {
    let spec = cronjob.spec.as_ref()?.job_template.spec.clone()?;
    Some(Job {
        metadata: ObjectMeta {
            name: Some(format!(
                "manual-{}-{seq}",
                cronjob.metadata.name.clone().unwrap_or_default()
            )),
            namespace: cronjob.metadata.namespace.clone(),
            ..Default::default()
        },
        spec: Some(strip_managed(spec)),
        ..Default::default()
    })
}

/// A retried copy of a failed Job (B47): delete + recreate from its own spec,
/// minus the controller-owned fields, named `<job>-retry-<seq>`.
pub fn retried_job(job: &Job, seq: u64) -> Option<Job> {
    let spec = job.spec.clone()?;
    Some(Job {
        metadata: ObjectMeta {
            name: Some(format!("{}-retry-{seq}", job.metadata.name.clone().unwrap_or_default())),
            namespace: job.metadata.namespace.clone(),
            ..Default::default()
        },
        spec: Some(strip_managed(spec)),
        ..Default::default()
    })
}

/// Remove the fields the Job controller owns, so the new Job is genuinely new.
fn strip_managed(mut spec: JobSpec) -> JobSpec {
    spec.selector = None;
    if let Some(labels) = spec.template.metadata.as_mut().and_then(|m| m.labels.as_mut()) {
        for k in MANAGED_LABELS {
            labels.remove(k);
        }
    }
    if let Some(ann) = spec.template.metadata.as_mut().and_then(|m| m.annotations.as_mut()) {
        for k in MANAGED_ANNOTATIONS {
            ann.remove(k);
        }
    }
    spec
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A CronJob with a jobTemplate whose template carries controller-managed
    /// labels/annotations and a selector — the fields a copy must strip.
    fn cronjob() -> CronJob {
        serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "CronJob",
            "metadata": { "name": "report-gen", "namespace": "prod", "uid": "cj1" },
            "spec": {
                "schedule": "0 */6 * * *",
                "jobTemplate": {
                    "spec": {
                        "selector": { "matchLabels": { "job-name": "report-gen-123" } },
                        "template": {
                            "metadata": {
                                "labels": { "app": "report", "controller-uid": "old", "job-name": "old" },
                                "annotations": { "batch.kubernetes.io/job-tracking": "old", "keep": "yes" },
                            },
                            "spec": {
                                "restartPolicy": "Never",
                                "containers": [{ "name": "report", "image": "busybox:1.36" }],
                            },
                        },
                    },
                },
            },
        }))
        .unwrap()
    }

    /// A Job that has run and failed, with controller-managed fields to strip.
    fn failed_job() -> Job {
        serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "migrate-42", "namespace": "prod", "uid": "j1" },
            "spec": {
                "selector": { "matchLabels": { "controller-uid": "old" } },
                "template": {
                    "metadata": {
                        "labels": { "controller-uid": "old", "job-name": "old", "app": "migrate" },
                        "annotations": { "batch.kubernetes.io/controller-uid": "old" },
                    },
                    "spec": {
                        "restartPolicy": "Never",
                        "containers": [{ "name": "migrate", "image": "busybox:1.36" }],
                    },
                },
            },
        }))
        .unwrap()
    }

    /// Run-now copies the CronJob's jobTemplate under a `manual-` name, stripping
    /// the selector and the controller-managed labels/annotations — the new Job
    /// is owned by nothing and gets a fresh identity.
    #[test]
    fn manual_job_copies_the_template_and_strips_managed_fields() {
        let job = manual_job(&cronjob(), 7).expect("a jobTemplate exists");
        assert_eq!(job.metadata.name.as_deref(), Some("manual-report-gen-7"));
        assert_eq!(job.metadata.namespace.as_deref(), Some("prod"));

        let spec = job.spec.expect("a spec");
        assert!(spec.selector.is_none(), "the Job controller assigns its own selector");
        let meta = spec.template.metadata.as_ref().expect("template metadata");
        let labels = meta.labels.as_ref().expect("labels");
        assert!(!labels.contains_key("controller-uid"), "controller-uid must be stripped");
        assert!(!labels.contains_key("job-name"), "job-name must be stripped");
        assert_eq!(labels.get("app").map(String::as_str), Some("report"), "user labels survive");
        let ann = meta.annotations.as_ref().expect("annotations");
        assert!(!ann.contains_key("batch.kubernetes.io/job-tracking"));
        assert_eq!(ann.get("keep").map(String::as_str), Some("yes"), "user annotations survive");
        // The container spec carries over untouched.
        let containers = spec.template.spec.as_ref().expect("pod spec").containers.clone();
        assert_eq!(containers[0].name, "report");
    }

    /// Retry copies the failed Job's own spec, minus the controller-owned fields,
    /// under a `<job>-retry-<seq>` name.
    #[test]
    fn retried_job_strips_the_controller_fields() {
        let job = retried_job(&failed_job(), 3).expect("a spec exists");
        assert_eq!(job.metadata.name.as_deref(), Some("migrate-42-retry-3"));
        let spec = job.spec.unwrap();
        assert!(spec.selector.is_none());
        let labels = spec
            .template
            .metadata
            .as_ref()
            .and_then(|m| m.labels.as_ref())
            .expect("labels");
        assert!(!labels.contains_key("controller-uid"));
        assert!(!labels.contains_key("job-name"));
        assert_eq!(labels.get("app").map(String::as_str), Some("migrate"));
    }

    /// The suspend patch is the same `spec.suspend` shape kubectl writes.
    #[test]
    fn suspend_patch_flips_the_flag() {
        assert_eq!(suspend_patch(true), json!({ "spec": { "suspend": true } }));
        assert_eq!(suspend_patch(false), json!({ "spec": { "suspend": false } }));
    }
}
