//! Live verification of the exec-credential path (B74-L) against the fixture:
//! a kubeconfig whose user authenticates through an exec plugin works end to
//! end — the plugin mints a token kind accepts, token expiry makes kube re-exec,
//! and the failure modes classify to `ExecMissing` / `ExecFailed` instead of a
//! generic string.
//!
//!   ./dev/cluster/up.sh
//!   KUBECONFIG=... cargo run --example exec_check
//!
//! Creates a ServiceAccount (+ ClusterRoleBinding to the read-only `view` role
//! and a token Secret) so the fake plugin's token is one kind actually accepts.
//! The fake plugin is dev/cluster/fake-exec.sh, driven by env vars from the
//! kubeconfig's `exec.env` (success / expired / bad / nonzero).

use k7s_lib::kube::client;
use k7s_lib::ErrorCode;
use k8s_openapi::api::core::v1::{Secret, ServiceAccount};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleRef, Subject};
use kube::api::{Api, ListParams, PostParams};
use kube::Client;
use std::path::{Path, PathBuf};

const NS: &str = "default";
const SA: &str = "k7s-exec-check";
const BINDING: &str = "k7s-exec-check-view";
const TOKEN_SECRET: &str = "k7s-exec-check-token";

/// The fake plugin the kubeconfig's exec block points at (checked-in, so it's
/// always present regardless of which examples cargo built).
fn fake_exec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../dev/cluster/fake-exec.sh")
}

/// Read the fixture cluster's server + CA from the default kubeconfig.
fn cluster_endpoint() -> (String, String) {
    let kc = kube::config::Kubeconfig::read().expect("default kubeconfig");
    let current = kc.current_context.clone().unwrap_or_default();
    let ctx = kc.contexts.iter().find(|c| c.name == current).expect("current context in kubeconfig");
    let cluster_name = ctx.context.as_ref().map(|c| c.cluster.clone()).unwrap_or_default();
    let cluster = kc.clusters.iter().find(|c| c.name == cluster_name).expect("current cluster");
    let inner = cluster.cluster.as_ref().expect("cluster body");
    (
        inner.server.clone().unwrap_or_default(),
        inner.certificate_authority_data.clone().unwrap_or_default(),
    )
}

/// Write a kubeconfig whose `exec` user points at the fake plugin, driven by the
/// given mode. Returns the path.
fn write_exec_kubeconfig(
    server: &str,
    ca_b64: &str,
    mode: &str,
    command: &str,
    token_file: &Path,
    count_file: &Path,
) -> PathBuf {
    let body = format!(
        concat!(
            "apiVersion: v1\n",
            "kind: Config\n",
            "current-context: exec\n",
            "clusters:\n",
            "- name: fixture\n",
            "  cluster:\n",
            "    server: {server}\n",
            "    certificate-authority-data: {ca}\n",
            "contexts:\n",
            "- name: exec\n",
            "  context:\n",
            "    cluster: fixture\n",
            "    user: exec-user\n",
            "users:\n",
            "- name: exec-user\n",
            "  user:\n",
            "    exec:\n",
            "      apiVersion: client.authentication.k8s.io/v1\n",
            "      command: {command}\n",
            "      env:\n",
            "      - name: K7S_FAKE_EXEC_MODE\n",
            "        value: {mode}\n",
            "      - name: K7S_FAKE_EXEC_TOKEN_FILE\n",
            "        value: {token}\n",
            "      - name: K7S_FAKE_EXEC_COUNT_FILE\n",
            "        value: {count}\n",
        ),
        server = server,
        ca = ca_b64,
        command = command,
        mode = mode,
        token = token_file.display(),
        count = count_file.display(),
    );
    let path = std::env::temp_dir().join(format!(
        "k7s-exec-kubeconfig-{}-{mode}.yaml",
        std::process::id()
    ));
    std::fs::write(&path, body).expect("write exec kubeconfig");
    path
}

fn temp_file(tag: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("k7s-exec-{tag}-{}", std::process::id()));
    std::fs::write(&path, "").ok();
    path
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::try_default().await?;

    // Idempotent across runs: clear any leftovers a previous (panicked) run left.
    let dp = kube::api::DeleteParams::default();
    let _ = Api::<ClusterRoleBinding>::all(client.clone()).delete(BINDING, &dp).await;
    let _ = Api::<Secret>::namespaced(client.clone(), NS).delete(TOKEN_SECRET, &dp).await;
    let _ = Api::<ServiceAccount>::namespaced(client.clone(), NS).delete(SA, &dp).await;

    // ---- fixture: an SA with read access (view role) + a token Secret ----
    let sa_api: Api<ServiceAccount> = Api::namespaced(client.clone(), NS);
    let sa: ServiceAccount = ServiceAccount {
        metadata: ObjectMeta { name: Some(SA.into()), namespace: Some(NS.into()), ..Default::default() },
        ..Default::default()
    };
    sa_api.create(&PostParams::default(), &sa).await.expect("create SA");

    let crb: ClusterRoleBinding = ClusterRoleBinding {
        metadata: ObjectMeta { name: Some(BINDING.into()), ..Default::default() },
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".into(),
            kind: "ClusterRole".into(),
            name: "view".into(),
        },
        subjects: Some(vec![Subject {
            api_group: None,
            kind: "ServiceAccount".into(),
            name: SA.into(),
            namespace: Some(NS.into()),
        }]),
    };
    Api::<ClusterRoleBinding>::all(client.clone()).create(&PostParams::default(), &crb).await.expect("create CRB");

    // A token Secret for the SA (kind's controller fills `data.token`).
    let secret: Secret = Secret {
        metadata: ObjectMeta {
            name: Some(TOKEN_SECRET.into()),
            namespace: Some(NS.into()),
            annotations: Some(
                [("kubernetes.io/service-account.name".to_string(), SA.to_string())]
                    .into_iter()
                    .collect(),
            ),
            ..Default::default()
        },
        type_: Some("kubernetes.io/service-account-token".into()),
        ..Default::default()
    };
    let secret_api: Api<Secret> = Api::namespaced(client.clone(), NS);
    secret_api.create(&PostParams::default(), &secret).await.expect("create token secret");

    let token = {
        let mut token = None;
        for _ in 0..40 {
            if let Ok(s) = secret_api.get(TOKEN_SECRET).await {
                if let Some(data) = s.data {
                    if let Some(tok) = data.get("token") {
                        token = Some(String::from_utf8(tok.0.clone()).unwrap_or_default());
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        token.expect("SA token Secret was populated")
    };
    println!("SA token obtained ({} chars)", token.len());
    let token_file = temp_file("token");
    std::fs::write(&token_file, &token)?;
    let (server, ca_b64) = cluster_endpoint();
    let plugin = fake_exec_path();
    println!("fake exec plugin: {}", plugin.display());

    // ---- success: a valid token, never re-exec'd after the initial mint ----
    // (kube invokes the plugin a couple of times while building the client — for
    // the auth layer and to check for client certificates — so the contrast is
    // that *requests* add nothing, not that the count is exactly one.)
    let count_file = temp_file("count-success");
    let kc = write_exec_kubeconfig(&server, &ca_b64, "success", &plugin.display().to_string(), &token_file, &count_file);
    let (exec_client, _) = client::build_client_from_file(kc.to_str().unwrap(), "exec")
        .await
        .map_err(|e| anyhow::anyhow!("exec build failed: {e}"))?;
    let calls_at_build = std::fs::read_to_string(&count_file).map(|s| s.lines().count()).unwrap_or(0);
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(exec_client.clone());
    pods.list(&ListParams::default()).await.expect("list pods through the exec-authenticated client");
    pods.list(&ListParams::default()).await.expect("second list");
    let calls = std::fs::read_to_string(&count_file).map(|s| s.lines().count()).unwrap_or(0);
    println!("success mode: {calls_at_build} at build, {calls} after two lists");
    assert_eq!(calls, calls_at_build, "a non-expiring token is never re-exec'd by requests");

    // ---- expiry: a past expirationTimestamp forces kube to re-exec ----
    let count_file = temp_file("count-expired");
    let kc = write_exec_kubeconfig(&server, &ca_b64, "expired", &plugin.display().to_string(), &token_file, &count_file);
    let (exec_client, _) = client::build_client_from_file(kc.to_str().unwrap(), "exec")
        .await
        .map_err(|e| anyhow::anyhow!("exec build failed: {e}"))?;
    let calls_at_build = std::fs::read_to_string(&count_file).map(|s| s.lines().count()).unwrap_or(0);
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(exec_client.clone());
    pods.list(&ListParams::default()).await.expect("list pods through an expiring exec token");
    pods.list(&ListParams::default()).await.expect("second list");
    let calls = std::fs::read_to_string(&count_file).map(|s| s.lines().count()).unwrap_or(0);
    println!("expired mode: {calls_at_build} at build, {calls} after two lists");
    assert!(calls > calls_at_build, "an expired token re-execs on the next request (build {calls_at_build}, after {calls})");

    // ---- failure modes classify, they don't stringify ----
    let missing = write_exec_kubeconfig(&server, &ca_b64, "success", "/nonexistent/k7s-fake-exec-xyz", &token_file, &temp_file("count-missing"));
    let e = match client::build_client_from_file(missing.to_str().unwrap(), "exec").await { Ok(_) => panic!("expected a classified failure"), Err(e) => e };
    println!("missing binary → {}", e.code());
    assert_eq!(e.code(), ErrorCode::ExecMissing, "a missing exec binary is ExecMissing, got {e:?}");

    let bad = write_exec_kubeconfig(&server, &ca_b64, "bad", &plugin.display().to_string(), &token_file, &temp_file("count-bad"));
    let e = match client::build_client_from_file(bad.to_str().unwrap(), "exec").await { Ok(_) => panic!("expected a classified failure"), Err(e) => e };
    println!("bad output → {}", e.code());
    assert_eq!(e.code(), ErrorCode::ExecFailed, "bad exec output is ExecFailed, got {e:?}");

    let nonzero = write_exec_kubeconfig(&server, &ca_b64, "nonzero", &plugin.display().to_string(), &token_file, &temp_file("count-nonzero"));
    let e = match client::build_client_from_file(nonzero.to_str().unwrap(), "exec").await { Ok(_) => panic!("expected a classified failure"), Err(e) => e };
    println!("non-zero exit → {}", e.code());
    assert_eq!(e.code(), ErrorCode::ExecFailed, "a non-zero exec exit is ExecFailed, got {e:?}");

    // ---- cleanup (best-effort) ----
    let _ = secret_api.delete(TOKEN_SECRET, &kube::api::DeleteParams::default()).await;
    let _ = sa_api.delete(SA, &kube::api::DeleteParams::default()).await;
    let _ = Api::<ClusterRoleBinding>::all(client).delete(BINDING, &kube::api::DeleteParams::default()).await;
    for p in [&token_file, &count_file] {
        let _ = std::fs::remove_file(p);
    }
    let _ = std::fs::remove_file(kc);
    let _ = std::fs::remove_file(missing);
    let _ = std::fs::remove_file(bad);
    let _ = std::fs::remove_file(nonzero);

    println!("\nExec path OK (success, expiry-re-exec, missing → ExecMissing, bad/nonzero → ExecFailed).");
    Ok(())
}
