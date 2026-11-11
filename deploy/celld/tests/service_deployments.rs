use celld::{
    deploy::{self, Options, VarOverrides},
    dev::open_local_bucket,
    generation::DeploymentGraph,
};
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn build(directory: &Path) -> anyhow::Result<deploy::Built> {
    deploy::build(&Options {
        config: Some(directory.to_path_buf()),
        bucket: None,
        endpoint: None,
        region: None,
        dry_run: false,
        named_only: false,
        json: false,
        vars: VarOverrides::None,
        local_images: true,
    })
}

fn project(directory: &Path, name: &str, source: &str, services: Value) {
    fs::create_dir_all(directory).unwrap();
    fs::write(directory.join("index.js"), source).unwrap();
    fs::write(
        directory.join("wrangler.json"),
        serde_json::to_vec(&json!({
            "name": name,
            "main": "index.js",
            "no_bundle": true,
            "services": services,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn named_deployment_preserves_public_selector_and_uses_native_graph() {
    let directory = tempfile::tempdir().unwrap();
    let backend = directory.path().join("backend");
    let web = directory.path().join("web");
    project(&backend, "baskule", "export default {};", json!([]));
    project(
        &web,
        "baskule-web",
        "export default {};",
        json!([{ "binding": "BACKEND", "service": "baskule" }]),
    );
    let bucket = open_local_bucket(&directory.path().join("objects.sqlite3")).unwrap();
    let first = build(&backend).unwrap();
    deploy::write_named(&bucket, &first).await.unwrap();
    assert!(bucket.get("deploy/current.json").await.unwrap().is_none());
    assert!(bucket
        .get(&format!("{}/manifest.json", first.prefix))
        .await
        .unwrap()
        .is_some());
    deploy::write(&bucket, &build(&web).unwrap()).await.unwrap();
    let public = bucket.get("deploy/current.json").await.unwrap().unwrap().0;
    fs::write(backend.join("index.js"), "export default {fetch(){}};").unwrap();
    let second = build(&backend).unwrap();
    assert_ne!(first.version, second.version);
    deploy::write_named(&bucket, &second).await.unwrap();
    assert_eq!(
        bucket.get("deploy/current.json").await.unwrap().unwrap().0,
        public
    );
    let graph = DeploymentGraph::load(&bucket, "test".to_string())
        .await
        .unwrap();
    assert_eq!(graph.primary.script_name, "baskule-web");
    assert_eq!(graph.cohosted.len(), 1);
    assert_eq!(graph.cohosted[0].script_name, "baskule");
    assert_eq!(graph.cohosted[0].version, second.version);
}

#[test]
fn named_only_is_explicit_and_supports_dry_run() {
    let defaults = deploy::options_from_arguments(Vec::new()).unwrap().unwrap();
    assert!(!defaults.named_only);
    let options = deploy::options_from_arguments(
        ["--named-only", "--dry-run", "backend/wrangler.json"].map(str::to_string),
    )
    .unwrap()
    .unwrap();
    assert!(options.named_only);
    assert!(options.dry_run);
    assert_eq!(options.config.unwrap(), Path::new("backend/wrangler.json"));
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        // Let the dev supervisor stop its native child before reaping it.
        unsafe { libc::kill(self.0.id() as libc::pid_t, libc::SIGTERM) };
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn dev_services_share_one_store_and_read_their_own_vars() {
    let directory = tempfile::tempdir().unwrap();
    for (path, name, value) in [
        ("backend", "baskule", "private"),
        ("second", "second", "second"),
    ] {
        let root = directory.path().join(path);
        project(
            &root,
            name,
            "export default {fetch(request,env){return Response.json(env.WHICH)}};",
            json!([]),
        );
        fs::write(root.join(".dev.vars"), format!("WHICH={value}\n")).unwrap();
    }
    project(
        directory.path(),
        "baskule-web",
        "export default {async fetch(request,env){return Response.json({web:env.WHICH,backend:await(await env.BACKEND.fetch(request)).json(),second:await(await env.SECOND.fetch(request)).json()})}};",
        json!([
            {"binding":"BACKEND","service":"baskule"},
            {"binding":"SECOND","service":"second"},
        ]),
    );
    fs::write(directory.path().join(".dev.vars"), "WHICH=public\n").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let log_path = directory.path().join("celld.log");
    let log = fs::File::create(&log_path).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_celld"))
        .current_dir(directory.path())
        .args([
            "dev",
            ".",
            "--no-watch",
            "--service",
            "backend/wrangler.json",
            "--service",
            "second",
            "--port",
            &port.to_string(),
        ])
        .env("CELLD_OTEL", "0")
        .env("DO_NOT_TRACK", "1")
        .env("CELLD_TOKIO_THREADS", "1")
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap();
    let mut running = Running(child);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            running.0.try_wait().unwrap().is_none(),
            "{}",
            fs::read_to_string(&log_path).unwrap()
        );
        if let Ok(response) = client
            .get(format!("{url}/.well-known/celld/health"))
            .send()
            .await
        {
            if response.status().is_success() {
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "{}",
            fs::read_to_string(&log_path).unwrap()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let response: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        response,
        json!({"web":"public","backend":"private","second":"second"})
    );
}
