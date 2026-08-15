//! Live verification of B74-L's per-kind isolation and outage recovery against
//! the fixture:
//!
//!   1. A restricted ServiceAccount (pods-only RBAC) proves the *per-kind*
//!      contract: listing pods is live, listing secrets is a classified
//!      `Forbidden` — a forbidden kind never looks like a healthy empty table.
//!   2. A `kubectl proxy` the harness controls proves outage recovery: the same
//!      client that lists pods through the proxy classifies an Unreachable when
//!      the proxy dies, and works again when it comes back.
//!
//!   ./dev/cluster/up.sh
//!   KUBECONFIG=... cargo run --example resilience_check

use k7s_lib::kube::client;
use k7s_lib::ErrorCode;
use k8s_openapi::api::core::v1::{Secret, ServiceAccount};
use k8s_openapi::api::rbac::v1::{PolicyRule, Role, RoleBinding, RoleRef, Subject};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use kube::Client;
use std::path::PathBuf;
use std::time::Duration;

const NS: &str = "default";
const SA: &str = "k7s-restricted";
const ROLE: &str = "k7s-pods-only";
const BINDING: &str = "k7s-pods-only-binding";
const TOKEN_SECRET: &str = "k7s-restricted-token";

/// Write a kubeconfig for the fixture cluster with a plain bearer-token user.
fn write_token_kubeconfig(server: &str, ca_b64: &str, token: &str) -> PathBuf {
    let body = format!(
        concat!(
            "apiVersion: v1\n",
            "kind: Config\n",
            "current-context: restricted\n",
            "clusters:\n",
            "- name: fixture\n",
            "  cluster:\n",
            "    server: {server}\n",
            "    certificate-authority-data: {ca}\n",
            "contexts:\n",
            "- name: restricted\n",
            "  context:\n",
            "    cluster: fixture\n",
            "    user: restricted-user\n",
            "users:\n",
            "- name: restricted-user\n",
            "  user:\n",
            "    token: {token}\n",
        ),
        server = server,
        ca = ca_b64,
        token = token,
    );
    let path = std::env::temp_dir().join(format!("k7s-restricted-kubeconfig-{}.yaml", std::process::id()));
    std::fs::write(&path, body).expect("write restricted kubeconfig");
    path
}

/// A kubeconfig pointing at a plain-HTTP endpoint with no auth (kubectl proxy).
fn write_proxy_kubeconfig(port: u16) -> PathBuf {
    let body = format!(
        concat!(
            "apiVersion: v1\n",
            "kind: Config\n",
            "current-context: proxy\n",
            "clusters:\n",
            "- name: proxy\n",
            "  cluster:\n",
            "    server: http://127.0.0.1:{port}\n",
            "    insecure-skip-tls-verify: true\n",
            "contexts:\n",
            "- name: proxy\n",
            "  context:\n",
            "    cluster: proxy\n",
            "    user: proxy-user\n",
            "users:\n",
            "- name: proxy-user\n",
            "  user: {{}}\n",
        ),
        port = port,
    );
    let path = std::env::temp_dir().join(format!("k7s-proxy-kubeconfig-{}.yaml", std::process::id()));
    std::fs::write(&path, body).expect("write proxy kubeconfig");
    path
}

fn cluster_endpoint() -> (String, String) {
    let kc = kube::config::Kubeconfig::read().expect("default kubeconfig");
    let current = kc.current_context.clone().unwrap_or_default();
    let ctx = kc.contexts.iter().find(|c| c.name == current).expect("current context");
    let cluster_name = ctx.context.as_ref().map(|c| c.cluster.clone()).unwrap_or_default();
    let cluster = kc.clusters.iter().find(|c| c.name == cluster_name).expect("current cluster");
    let inner = cluster.cluster.as_ref().expect("cluster body");
    (
        inner.server.clone().unwrap_or_default(),
        inner.certificate_authority_data.clone().unwrap_or_default(),
    )
}

/// Create the restricted SA + pods-only role/binding and return its token.
async fn restricted_token(client: &Client) -> String {
    let sa_api: Api<ServiceAccount> = Api::namespaced(client.clone(), NS);
    let sa: ServiceAccount = ServiceAccount {
        metadata: ObjectMeta { name: Some(SA.into()), namespace: Some(NS.into()), ..Default::default() },
        ..Default::default()
    };
    let _ = sa_api.create(&PostParams::default(), &sa).await;

    let role: Role = Role {
        metadata: ObjectMeta { name: Some(ROLE.into()), namespace: Some(NS.into()), ..Default::default() },
        rules: Some(vec![PolicyRule {
            api_groups: Some(vec!["".into()]),
            resources: Some(vec!["pods".into()]),
            verbs: vec!["get".into(), "list".into(), "watch".into()],
            ..Default::default()
        }]),
    };
    let _ = Api::<Role>::namespaced(client.clone(), NS).create(&PostParams::default(), &role).await;

    let rb: RoleBinding = RoleBinding {
        metadata: ObjectMeta { name: Some(BINDING.into()), namespace: Some(NS.into()), ..Default::default() },
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".into(),
            kind: "Role".into(),
            name: ROLE.into(),
        },
        subjects: Some(vec![Subject {
            api_group: None,
            kind: "ServiceAccount".into(),
            name: SA.into(),
            namespace: Some(NS.into()),
        }]),
    };
    let _ = Api::<RoleBinding>::namespaced(client.clone(), NS).create(&PostParams::default(), &rb).await;

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
    let _ = secret_api.create(&PostParams::default(), &secret).await;

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
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    token.expect("restricted SA token was populated")
}

/// Spawn `kubectl proxy` on a free port and return (child, port). Panics if
/// kubectl isn't on PATH.
fn spawn_proxy() -> (std::process::Child, u16) {
    use std::io::Read;
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);

    let mut child = std::process::Command::new("kubectl")
        .args(["proxy", "--port", &port.to_string(), "--address", "127.0.0.1"])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("kubectl on PATH");
    // The proxy prints "Starting to serve on ..." to stdout once ready; drain
    // enough to be sure it's listening before returning.
    let mut stdout = child.stdout.take().expect("proxy stdout");
    let mut buf = [0u8; 256];
    let mut out = String::new();
    for _ in 0..50 {
        match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
                if out.contains("Starting to serve") {
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !out.contains("Starting to serve") {
        panic!("kubectl proxy did not report ready: {out}");
    }
    (child, port)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let admin = Client::try_default().await?;

    // ---- per-kind isolation: pods live, secrets Forbidden ----
    let token = restricted_token(&admin).await;
    let (server, ca_b64) = cluster_endpoint();
    let restricted_kc = write_token_kubeconfig(&server, &ca_b64, &token);
    let (restricted, _) = client::build_client_from_file(restricted_kc.to_str().unwrap(), "restricted")
        .await
        .map_err(|e| anyhow::anyhow!("restricted client build failed: {e}"))?;

    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(restricted.clone(), NS);
    let listed = pods.list(&ListParams::default()).await.expect("restricted SA lists pods (live)");
    println!("restricted SA lists pods: {} rows", listed.items.len());

    let secrets: Api<Secret> = Api::namespaced(restricted.clone(), NS);
    let e = match secrets.list(&ListParams::default()).await {
        Ok(_) => panic!("a pods-only SA must not list secrets"),
        Err(e) => k7s_lib::AppError::from(e),
    };
    println!("restricted SA lists secrets → {}", e.code());
    assert_eq!(e.code(), ErrorCode::Forbidden, "secrets is Forbidden for a pods-only SA");

    // ---- outage + recovery through a controllable proxy ----
    let (mut proxy, port) = spawn_proxy();
    let proxy_kc = write_proxy_kubeconfig(port);
    let (proxy_client, _) = client::build_client_from_file(proxy_kc.to_str().unwrap(), "proxy")
        .await
        .map_err(|e| anyhow::anyhow!("proxy client build failed: {e}"))?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(proxy_client.clone());
    pods.list(&ListParams::default()).await.expect("list through the live proxy");

    // Kill the proxy → the same client must classify Unreachable, not hang or
    // throw a generic string.
    proxy.kill().expect("kill proxy");
    let _ = proxy.wait();
    std::thread::sleep(Duration::from_millis(300));
    let e = match pods.list(&ListParams::default()).await {
        Ok(_) => panic!("the dead proxy must not serve lists"),
        Err(e) => k7s_lib::AppError::from(e),
    };
    println!("proxy down → {}", e.code());
    assert_eq!(e.code(), ErrorCode::Unreachable, "a dead API is classified Unreachable, got {e:?}");

    // Bring it back → the same client recovers (auto-clear).
    let (mut proxy, port) = spawn_proxy();
    let proxy_kc = write_proxy_kubeconfig(port);
    let (proxy_client, _) = client::build_client_from_file(proxy_kc.to_str().unwrap(), "proxy")
        .await
        .map_err(|e| anyhow::anyhow!("proxy client rebuild failed: {e}"))?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(proxy_client.clone());
    let recovered = pods.list(&ListParams::default()).await.expect("list through the restarted proxy");
    println!("proxy restarted → lists {} rows", recovered.items.len());

    // ---- cleanup ----
    proxy.kill().ok();
    let _ = Api::<Secret>::namespaced(admin.clone(), NS).delete(TOKEN_SECRET, &DeleteParams::default()).await;
    let _ = Api::<ServiceAccount>::namespaced(admin.clone(), NS).delete(SA, &DeleteParams::default()).await;
    let _ = Api::<Role>::namespaced(admin.clone(), NS).delete(ROLE, &DeleteParams::default()).await;
    let _ = Api::<RoleBinding>::namespaced(admin, NS).delete(BINDING, &DeleteParams::default()).await;
    let _ = std::fs::remove_file(&restricted_kc);
    let _ = std::fs::remove_file(&proxy_kc);

    println!("\nResilience OK (pods live / secrets Forbidden; proxy outage → Unreachable → recovery).");
    Ok(())
}
