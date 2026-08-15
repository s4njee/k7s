//! Live verification of the B80 kind-sweep tables (HPA, PDB, NetworkPolicy,
//! ResourceQuota, LimitRange, admission webhooks) against a real cluster,
//! through the same mappers the watchers use:
//!
//!   KUBECONFIG=/path/to/kubeconfig cargo run --example kinds_check
//!
//! Read-only. Renders each table as the UI would and asserts the column
//! contract (cell count per kind, namespace scoping) matches src/lib/kinds.ts,
//! then cross-checks the joins that answer real questions: the PDB's selector
//! actually selects pods, and the HPA's scaleTargetRef resolves.

use k7s_lib::kube::mappers::{
    map_hpa, map_limitrange, map_mutatingwebhookconfiguration, map_networkpolicy, map_pdb,
    map_resourcequota, map_validatingwebhookconfiguration,
};
use k8s_openapi::api::admissionregistration::v1::{
    MutatingWebhookConfiguration, ValidatingWebhookConfiguration,
};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::core::v1::{LimitRange, Pod, ResourceQuota};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::api::{Api, ListParams};
use kube::{Client, ResourceExt};
use std::collections::HashMap;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // ---- HorizontalPodAutoscalers ----
    let hpas: Api<HorizontalPodAutoscaler> = Api::all(client.clone());
    let list = hpas.list(&ListParams::default()).await?;
    println!("HorizontalPodAutoscalers ({}):", list.items.len());
    println!("  {:<20} {:<10} {:<26} {:<18} {:<7} {:<7} {:<8}", "NAME", "NAMESPACE", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS");
    let mut hpa_targets: HashMap<String, String> = HashMap::new();
    for h in &list.items {
        let row = map_hpa(h);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<20} {:<10} {:<26} {:<18} {:<7} {:<7} {}", t(0), t(1), t(2), t(3), t(4), t(5), t(6));
        assert_eq!(row.cells.len(), 8, "HPA rows must fill the 8-column contract");
        assert!(row.namespace.is_some(), "an HPA is namespaced");
        hpa_targets.insert(t(0), t(2));
    }
    assert!(!hpa_targets.is_empty(), "the fixture has an HPA to check");

    // ---- PodDisruptionBudgets ----
    let pdbs: Api<PodDisruptionBudget> = Api::all(client.clone());
    let list = pdbs.list(&ListParams::default()).await?;
    println!("\nPodDisruptionBudgets ({}):", list.items.len());
    println!("  {:<20} {:<10} {:<13} {:<13} {:<15} {:<20}", "NAME", "NAMESPACE", "MIN AVAILABLE", "MAX UNAVAILABLE", "CURRENT HEALTHY", "DISRUPTIONS ALLOWED");
    let mut pdb_selectors: HashMap<String, (String, String, std::collections::BTreeMap<String, String>)> = HashMap::new();
    for p in &list.items {
        let row = map_pdb(p);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<20} {:<10} {:<13} {:<13} {:<15} {}", t(0), t(1), t(2), t(3), t(4), t(5));
        assert_eq!(row.cells.len(), 7, "PDB rows must fill B61's 7-column contract");
        assert!(row.namespace.is_some(), "a PDB is namespaced");
        pdb_selectors.insert(t(0), (t(1), t(2), row.selector.clone().unwrap_or_default()));
    }
    assert!(!pdb_selectors.is_empty(), "the fixture has a PDB to check");

    // ---- NetworkPolicies ----
    let nps: Api<NetworkPolicy> = Api::all(client.clone());
    let list = nps.list(&ListParams::default()).await?;
    println!("\nNetworkPolicies ({}):", list.items.len());
    println!("  {:<20} {:<10} {:<22}", "NAME", "NAMESPACE", "POD-SELECTOR");
    for np in &list.items {
        let row = map_networkpolicy(np);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<20} {:<10} {}", t(0), t(1), t(2));
        assert_eq!(row.cells.len(), 4, "NetworkPolicy rows must fill the 4-column contract");
        assert!(row.namespace.is_some(), "a NetworkPolicy is namespaced");
    }

    // ---- ResourceQuotas ----
    let rqs: Api<ResourceQuota> = Api::all(client.clone());
    let list = rqs.list(&ListParams::default()).await?;
    println!("\nResourceQuotas ({}):", list.items.len());
    println!("  {:<16} {:<10} {:<70} {:<40}", "NAME", "NAMESPACE", "REQUEST", "LIMIT");
    for rq in &list.items {
        let row = map_resourcequota(rq);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<16} {:<10} {:<70} {}", t(0), t(1), t(2), t(3));
        assert_eq!(row.cells.len(), 5, "ResourceQuota rows must fill the 5-column contract");
        assert!(row.namespace.is_some(), "a quota is namespaced");
    }

    // ---- LimitRanges ----
    let lrs: Api<LimitRange> = Api::all(client.clone());
    let list = lrs.list(&ListParams::default()).await?;
    println!("\nLimitRanges ({}):", list.items.len());
    println!("  {:<16} {:<10} {:<40}", "NAME", "NAMESPACE", "TYPES");
    for lr in &list.items {
        let row = map_limitrange(lr);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<16} {:<10} {}", t(0), t(1), t(2));
        assert_eq!(row.cells.len(), 4, "LimitRange rows must fill the 4-column contract");
        assert!(row.namespace.is_some(), "a LimitRange is namespaced");
    }

    // ---- Admission webhook configurations (cluster-scoped) ----
    let mut webhook_count = 0;
    let mwc: Api<MutatingWebhookConfiguration> = Api::all(client.clone());
    let list = mwc.list(&ListParams::default()).await?;
    println!("\nMutatingWebhookConfigurations ({}):", list.items.len());
    for w in &list.items {
        let row = map_mutatingwebhookconfiguration(w);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<40} {:<8} {}", t(0), t(1), t(2));
        assert_eq!(row.cells.len(), 3, "webhook rows must fill the 3-column contract");
        assert!(row.namespace.is_none(), "a webhook config is cluster-scoped — no namespace column");
        webhook_count += 1;
    }
    let vwc: Api<ValidatingWebhookConfiguration> = Api::all(client.clone());
    let list = vwc.list(&ListParams::default()).await?;
    println!("ValidatingWebhookConfigurations ({}):", list.items.len());
    for w in &list.items {
        let row = map_validatingwebhookconfiguration(w);
        let t = |i: usize| row.cells[i].text.clone();
        println!("  {:<40} {:<8} {}", t(0), t(1), t(2));
        assert_eq!(row.cells.len(), 3, "webhook rows must fill the 3-column contract");
        assert!(row.namespace.is_none(), "a webhook config is cluster-scoped — no namespace column");
        webhook_count += 1;
    }
    assert!(webhook_count > 0, "the fixture has webhook configs to check");

    // ---- cross-checks ----
    // The fixture PDB (yggdrasil-db, minAvailable 2) must actually select pods —
    // every matchLabel matching a pod label in the same namespace.
    let pods: Api<Pod> = Api::all(client.clone());
    let all_pods = pods.list(&ListParams::default()).await?;
    let mut selected = 0;
    for (name, (ns, _min, selector)) in &pdb_selectors {
        let labels: Vec<String> = all_pods
            .items
            .iter()
            .filter(|p| {
                p.namespace().as_deref() == Some(ns.as_str())
                    && selector.iter().all(|(k, v)| {
                        p.metadata.labels.as_ref().and_then(|l| l.get(k)) == Some(v)
                    })
            })
            .map(|p| p.name_any())
            .collect();
        println!("\nPDB {name} selects {} pod(s): {}", labels.len(), labels.join(", "));
        assert!(!labels.is_empty(), "the fixture PDB must select at least one pod");
        selected += 1;
    }
    assert!(selected > 0, "the fixture has a PDB whose selector selects pods");

    // The HPA's scaleTargetRef (Deployment/valkyrie-api) must resolve.
    let deps: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let deployments = deps.list(&ListParams::default()).await?;
    for (name, ref_text) in &hpa_targets {
        let target = ref_text.split('/').collect::<Vec<_>>();
        assert_eq!(target.len(), 2, "HPA reference must be Kind/name: {ref_text}");
        let kind = target[0];
        let dep_name = target[1];
        if kind == "Deployment" {
            let found = deployments.items.iter().any(|d| d.name_any() == dep_name);
            assert!(found, "HPA {name} references Deployment/{dep_name}, which doesn't exist");
        }
        println!("HPA {name} scales {ref_text} (resolves)");
    }

    println!("\nKind-sweep tables OK.");
    Ok(())
}
