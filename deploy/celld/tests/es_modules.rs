use celld::{
    deploy::{self, Options, VarOverrides},
    engine_api::ModuleSource,
    js::{Worker, WorkerConfig, WorkerConfigOptions},
    protocol::{ModuleKind, FEATURE_ES_MODULES_V1},
    WorkerJob,
};
use std::{fs, path::Path, sync::Arc, time::Instant};

fn build(directory: &Path) -> anyhow::Result<deploy::Built> {
    deploy::build(&Options {
        config: Some(directory.to_path_buf()),
        bucket: None,
        endpoint: None,
        region: None,
        dry_run: true,
        json: false,
        vars: VarOverrides::None,
        local_images: false,
    })
}

fn project(directory: &Path, main: &str) {
    fs::write(
        directory.join("wrangler.json"),
        format!(r#"{{"name":"modules-test","main":"{main}","no_bundle":true}}"#),
    )
    .unwrap();
}

#[test]
fn unbundled_deployment_preserves_module_bytes_kinds_and_identity() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("chunks")).unwrap();
    project(directory.path(), "index.js");
    fs::write(directory.path().join("index.js"), "export default {};").unwrap();
    fs::write(directory.path().join("chunks/b.mjs"), "export const b=2;").unwrap();
    fs::write(directory.path().join("chunks/a.js"), "export const a=1;").unwrap();
    fs::write(directory.path().join("chunks/ignored.map"), "{}").unwrap();
    fs::write(directory.path().join("empty.wasm"), b"\0asm\x01\0\0\0").unwrap();
    let first = build(directory.path()).unwrap();
    let second = build(directory.path()).unwrap();
    assert_eq!(first.version, second.version);
    assert_eq!(first.modules, second.modules);
    assert_eq!(
        first
            .modules
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        vec!["index.js", "empty.wasm", "chunks/a.js", "chunks/b.mjs"]
    );
    celld::protocol::validate_required_features(&first.manifest.required_features).unwrap();
    assert!(
        celld::protocol::validate_required_features(&["unavailable-future-feature".into()])
            .is_err()
    );
    assert!(first
        .manifest
        .required_features
        .iter()
        .any(|feature| feature == FEATURE_ES_MODULES_V1));
    assert!(matches!(
        first.manifest.modules[1].kind,
        Some(ModuleKind::Wasm)
    ));
    assert!(matches!(
        first.manifest.modules[2].kind,
        Some(ModuleKind::EsModule)
    ));
    assert_eq!(first.modules[2].1, b"export const a=1;");
    fs::write(directory.path().join("chunks/a.js"), "export const a=3;").unwrap();
    assert_ne!(first.version, build(directory.path()).unwrap().version);
}

#[test]
fn multi_module_entries_keep_the_runtime_main_name() {
    let directory = tempfile::tempdir().unwrap();
    project(directory.path(), "worker.js");
    fs::write(directory.path().join("worker.js"), "export default {};").unwrap();
    assert!(
        build(directory.path()).is_ok(),
        "legacy single files remain supported"
    );
    fs::write(directory.path().join("chunk.js"), "export const value=1;").unwrap();
    assert!(build(directory.path())
        .err()
        .unwrap()
        .to_string()
        .contains("index.js"));
}

#[cfg(unix)]
#[test]
fn discovery_does_not_follow_symlinks_or_include_dependency_trees() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    project(directory.path(), "index.js");
    fs::write(directory.path().join("index.js"), "export default {};").unwrap();
    fs::write(outside.path().join("secret.js"), "private").unwrap();
    symlink(outside.path(), directory.path().join("outside")).unwrap();
    fs::create_dir(directory.path().join("node_modules")).unwrap();
    fs::write(
        directory.path().join("node_modules/unrelated.js"),
        "unrelated",
    )
    .unwrap();
    assert_eq!(build(directory.path()).unwrap().modules.len(), 1);
    symlink(
        outside.path().join("secret.js"),
        directory.path().join("secret.js"),
    )
    .unwrap();
    assert!(build(directory.path())
        .err()
        .unwrap()
        .to_string()
        .contains("not a regular file"));
}

fn load_worker(main: &str, modules: Vec<(&str, ModuleSource)>) -> anyhow::Result<Worker> {
    Worker::load_config(Arc::new(WorkerConfig::new(WorkerConfigOptions {
        src: main.into(),
        script_name: "modules-test".into(),
        do_classes: vec![],
        bindings: vec![],
        r2_bindings: vec![],
        d1_bindings: vec![],
        kv_bindings: vec![],
        queue_bindings: vec![],
        queue_consumers: vec![],
        workflow_bindings: vec![],
        vars: vec![],
        node: "test".into(),
        modules: modules
            .into_iter()
            .map(|(name, source)| (name.into(), source))
            .collect(),
        compat: Default::default(),
    })))
}

fn source(source: &str) -> ModuleSource {
    ModuleSource::EsModule(source.into())
}

fn fetch(worker: &mut Worker, path: &str) -> String {
    let (send, mut receive) = tokio::sync::oneshot::channel();
    let (entry, ops) = worker.turn_begin(
        WorkerJob::Fetch {
            queued_at: Instant::now(),
            entrypoint: None,
            invocation_limits: None,
            url: format!("http://test{path}"),
            method: "GET".into(),
            body: Vec::new().into(),
            headers: vec![],
            request_id: None,
            tail_report: None,
            reply: send,
        },
        None,
    );
    assert!(ops.is_empty(), "module-only fetch requires no native I/O");
    if let Some(mut entry) = entry {
        for _ in 0..100 {
            if entry.finished() {
                break;
            }
            assert!(worker.turn_poll(&mut entry).is_empty());
        }
        assert!(entry.finished(), "module fetch must settle");
    }
    let response = receive.try_recv().unwrap().unwrap();
    assert_eq!(response.status, 200);
    assert!(response.stream.is_none());
    String::from_utf8(response.body).unwrap()
}

// Keep V8 initialization and all workers in one test process/thread.
#[test]
fn real_v8_static_dynamic_relative_imports_are_lazy_and_share_instances() {
    celld::runtime::init_v8();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _entered = runtime.enter();
    let mut worker = load_worker(r#"
        import {token} from './shared.js';
        import {value} from './nested/static.js';
        import {basename} from 'node:path';
        import wasm from './empty.wasm';
        export default {async fetch(req) {
            const path = new URL(req.url).pathname;
            if (path !== '/') {
                try { await import('./' + path.slice(1) + '.js'); return new Response('unexpected'); }
                catch (error) { return new Response(error.name + ':' + error.message); }
            }
            const [a,b] = await Promise.all([import('./nested/lazy.mjs'), import('./nested/lazy.mjs')]);
            const shared = await a.shared();
            const pathModule = await import('node:path');
            return new Response(JSON.stringify([value, basename('/a/x'), a.parent, a===b, a.token===token, shared.token===token, a.count, wasm instanceof WebAssembly.Module, pathModule.extname("a.txt")]));
        }};
    "#, vec![
        ("shared.js", source("export const token={};")),
        ("nested/static.js", source("import {token} from '../shared.js'; export const value=token ? 7 : 0;")),
        ("nested/lazy.mjs", source("import {token} from '../shared.js'; import {dirname} from 'node:path'; export {token}; export const parent=dirname('/a/x'); export const count=globalThis.moduleCount=(globalThis.moduleCount??0)+1; export const shared=()=>import('../shared.js');")),
        ("bad.js", source("export const bad = ;")),
        ("throws.js", source("throw new Error('lazy-failure'); export const value=1;")),
        ("empty.wasm", ModuleSource::Wasm(b"\0asm\x01\0\0\0".as_slice().to_vec().into())),
    ]).unwrap();
    assert_eq!(
        fetch(&mut worker, "/"),
        r#"[7,"x","/a",true,true,true,1,true,".txt"]"#
    );
    assert_eq!(
        fetch(&mut worker, "/"),
        r#"[7,"x","/a",true,true,true,1,true,".txt"]"#
    );
    assert!(fetch(&mut worker, "/bad").starts_with("SyntaxError:"));
    assert!(fetch(&mut worker, "/missing").contains("not supported"));
    assert_eq!(fetch(&mut worker, "/throws"), "Error:lazy-failure");
    assert_eq!(fetch(&mut worker, "/throws"), "Error:lazy-failure");
    drop(worker);
    assert!(load_worker(
        "import './bad.js'; export default {fetch(){return new Response('unreachable');}};",
        vec![("bad.js", source("export const bad = ;"))]
    )
    .is_err());
}
