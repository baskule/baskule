use celld::{
    js::{Worker, WorkerConfig, WorkerConfigOptions},
    pool::Pool,
};
use celld_logic::isolate::PoolLimits;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

// One test initializes V8 before creating the runtime threads.
#[test]
fn real_worker_retention_reclamation_and_generation_replacement() {
    celld::runtime::init_v8();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _entered = runtime.enter();
    celld::asyncrt::set_host_handle(runtime.handle().clone());
    let builds = Arc::new(AtomicUsize::new(0));
    let config = Arc::new(WorkerConfig::new(WorkerConfigOptions {
        src: "export default { fetch() { return new Response('ok'); } };".into(),
        script_name: "retention-test".into(),
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
        modules: vec![],
        compat: Default::default(),
    }));
    let make_pool = || {
        let config = config.clone();
        let builds = builds.clone();
        Pool::new(
            PoolLimits {
                grow_at: 2,
                shrink_under: 1,
                max_stateless: 4,
                max_requests: Some(2),
                max_cells: 1,
            },
            Duration::from_millis(10),
            Box::new(move || {
                builds.fetch_add(1, Ordering::Relaxed);
                Worker::load_config(config.clone())
            }),
        )
    };

    let pool = make_pool();
    for _ in 0..4 {
        pool.warm().unwrap();
    }
    for _ in 0..10 {
        pool.reap();
    }
    assert_eq!(pool.live(), 1);
    assert_eq!(pool.census().freed, 3);
    let built = builds.load(Ordering::Relaxed);
    let request = pool.admit(false).unwrap();
    let heap = request.slot().heap_id();
    for _ in 0..10 {
        pool.reap();
    }
    let second = pool.admit(false).unwrap();
    assert_eq!(second.slot().heap_id(), heap);
    assert!(pool.admit(false).is_err(), "request cap must still hold");
    assert!(
        pool.admit(true).is_err(),
        "a full pool under pressure must still refuse admission"
    );
    assert_eq!(builds.load(Ordering::Relaxed), built);
    drop(second);
    let under_pressure = pool.admit(true).unwrap();
    assert_eq!(under_pressure.slot().heap_id(), heap);
    drop(under_pressure);

    pool.retire_all();
    assert_eq!(pool.live(), 0);
    assert!(!pool.is_drained(), "suspended request must keep its heap");
    runtime.block_on(
        request
            .slot()
            .turn(|worker| assert!(worker.heap_bytes().is_some())),
    );
    drop(request);
    pool.reap();
    assert!(pool.is_drained(), "superseded generation must fully drain");

    let cells = make_pool();
    let cell = cells.place_cell().unwrap();
    let other = cells.place_cell().unwrap();
    assert_eq!(cells.live(), 2);
    cells.reap_empty();
    assert_eq!(cells.live(), 2, "resident cells must keep their heaps");
    drop(other);
    cells.reap_empty();
    assert_eq!(cells.live(), 1);
    cells.retire_all();
    assert!(!cells.is_drained());
    drop(cell);
    cells.reap_empty();
    assert!(cells.is_drained());

    let empty_cells = make_pool();
    let cell = empty_cells.place_cell().unwrap();
    drop(cell);
    empty_cells.reap_empty();
    assert_eq!(empty_cells.live(), 1, "retain the evaluated module graph");
    assert!(!empty_cells.is_drained());
    let built = builds.load(Ordering::Relaxed);
    let cell = empty_cells.place_cell().unwrap();
    drop(cell);
    for _ in 0..10 {
        empty_cells.reap_empty();
    }
    assert_eq!(
        builds.load(Ordering::Relaxed),
        built,
        "wake reuses its isolate"
    );
    empty_cells.retire_all();
    empty_cells.reap_empty();
    assert!(
        empty_cells.is_drained(),
        "old generations must release retained heaps"
    );

    let directory = tempfile::tempdir().unwrap();
    let cell_config = WorkerConfigOptions {
        src: r#"
            import {DurableObject} from 'cloudflare:workers';
            const token=crypto.randomUUID();
            export class Probe extends DurableObject {
                constructor(ctx, env) { super(ctx, env); this.calls=0; this.garbage=new Array(1000000).fill(42); }
                fetch() { this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof (value INTEGER)').toArray(); this.ctx.storage.sql.exec('INSERT INTO proof VALUES (1)'); this.ctx.storage.kv.put('fresh', 1); this.ctx.storage.sql.exec('SELECT 1').toArray(); return new Response(JSON.stringify([++this.calls, token, this.ctx.id.name])); }
                [Symbol.dispose]() { globalThis.released=(globalThis.released??0)+1; (globalThis.stale??={})[this.ctx.id.name]=this.ctx.storage; if(this.ctx.id.name==='throw')throw new Error('failed release'); }
            }
            export default { fetch(req, env) {
                const path=new URL(req.url).pathname;
                if(path==='/stale' || path==='/stale-control') {
                    const storage=globalThis.stale.first;
                    const aborted=storage._state._aborted;
                    // Negative control: with the guard removed, the old incarnation
                    // can reach the same re-opened connection. Restore it afterwards.
                    if(path==='/stale-control')storage._state._aborted=false;
                    try {
                        let sql=false,kv=false;
                        try{storage.sql.exec('SELECT 1')}catch{sql=true}
                        try{storage.kv.get('probe')}catch{kv=true}
                        return new Response(JSON.stringify({sql,kv}));
                    } finally {storage._state._aborted=aborted;}
                }
                return new Response(path === '/identities' ? JSON.stringify([env.PROBES.idFromName('first').toString(), env.PROBES.idFromName('second').toString(), env.PROBES.idFromName('throw').toString()]) : String(globalThis.released??0));
            } };
        "#.into(),
        script_name: "real-cell-retention".into(), do_classes: vec!["Probe".into()],
        bindings: vec![("PROBES".into(), "Probe".into())], r2_bindings: vec![], d1_bindings: vec![], kv_bindings: vec![],
        queue_bindings: vec![], queue_consumers: vec![], workflow_bindings: vec![],
        vars: vec![], node: "test".into(), modules: vec![], compat: Default::default(),
    };
    let config = Arc::new(WorkerConfig::new(cell_config));
    let real_cells = Pool::new(
        PoolLimits {
            grow_at: 2,
            shrink_under: 1,
            max_stateless: 1,
            max_requests: None,
            max_cells: 2,
        },
        Duration::from_millis(10),
        Box::new(move || Worker::load_config(config.clone())),
    );
    let reserved = real_cells.place_cell().unwrap();
    let identities: Vec<String> = serde_json::from_str(
        &runtime.block_on(
            reserved
                .slot()
                .turn(|worker| native_worker_fetch(worker, "/identities")),
        ),
    )
    .unwrap();
    let first_scope = format!("Probe:{}", identities[0]);
    let second_scope = format!("Probe:{}", identities[1]);
    let db_a = directory.path().join("a.sqlite");
    let db_b = directory.path().join("b.sqlite");
    let (mut first, _) = runtime
        .block_on(reserved.adopt(
            &first_scope,
            celld::js::CellStorage {
                path: db_a.to_str().unwrap(),
                epoch: 1,
                replicated_wake: false,
                vfs: None,
            },
        ))
        .unwrap();
    let heap = first.slot().heap_id();
    let a: serde_json::Value = serde_json::from_str(
        &runtime.block_on(
            first
                .slot()
                .turn(|worker| native_cell_fetch(worker, &first_scope, "first")),
        ),
    )
    .unwrap();
    assert_eq!(a[0], 1);
    assert_eq!(a[2], "first");
    runtime.block_on(first.release(&first_scope)).unwrap();
    drop(first);
    real_cells.reap_empty();
    assert_eq!(real_cells.live(), 1);
    #[cfg(target_os = "linux")]
    for fd in std::fs::read_dir("/proc/self/fd").unwrap().flatten() {
        if let Ok(path) = std::fs::read_link(fd.path()) {
            assert!(
                !path.starts_with(&db_a),
                "released SQLite descriptor remains open"
            );
        }
    }
    let (mut second, _) = runtime
        .block_on(real_cells.place_cell().unwrap().adopt(
            &second_scope,
            celld::js::CellStorage {
                path: db_b.to_str().unwrap(),
                epoch: 1,
                replicated_wake: false,
                vfs: None,
            },
        ))
        .unwrap();
    assert_eq!(second.slot().heap_id(), heap);
    let b: serde_json::Value = serde_json::from_str(
        &runtime.block_on(
            second
                .slot()
                .turn(|worker| native_cell_fetch(worker, &second_scope, "second")),
        ),
    )
    .unwrap();
    assert_eq!(b[0], 1);
    assert_eq!(b[1], a[1]);
    assert_eq!(b[2], "second");
    runtime.block_on(second.release(&second_scope)).unwrap();
    drop(second);
    let released_count = runtime.block_on(
        real_cells
            .place_cell()
            .unwrap()
            .slot()
            .turn(|worker| native_worker_fetch(worker, "/released")),
    );
    assert_eq!(
        released_count, "2",
        "real cells must receive synchronous release cleanup"
    );
    let (mut keeper, _) = runtime
        .block_on(real_cells.place_cell().unwrap().adopt(
            &first_scope,
            celld::js::CellStorage {
                path: db_a.to_str().unwrap(),
                epoch: 2,
                replicated_wake: false,
                vfs: None,
            },
        ))
        .unwrap();
    let keeper_heap = keeper.slot().heap_id();
    assert_eq!(
        keeper_heap, heap,
        "the same scope must be re-adopted in the retained heap"
    );
    let stale = runtime.block_on(
        keeper
            .slot()
            .turn(|worker| native_worker_fetch(worker, "/stale")),
    );
    assert_eq!(
        stale, "{\"sql\":true,\"kv\":true}",
        "old first-incarnation storage reached its re-adopted connection"
    );
    let control = runtime.block_on(
        keeper
            .slot()
            .turn(|worker| native_worker_fetch(worker, "/stale-control")),
    );
    assert_eq!(
        control, "{\"sql\":false,\"kv\":false}",
        "the stale test must fail when its aborted guard is bypassed"
    );
    // The new incarnation's connection is open and usable. A closed connection
    // would make the preceding assertion pass even without the aborted flag.
    let fresh: serde_json::Value = serde_json::from_str(
        &runtime.block_on(
            keeper
                .slot()
                .turn(|worker| native_cell_fetch(worker, &first_scope, "first")),
        ),
    )
    .unwrap();
    assert_eq!(fresh[0], 1);
    assert_eq!(fresh[1], a[1]);
    let failed_scope = format!("Probe:{}", identities[2]);
    let failed_db = directory.path().join("failed.sqlite");
    let (mut failed, _) = runtime
        .block_on(real_cells.place_cell().unwrap().adopt(
            &failed_scope,
            celld::js::CellStorage {
                path: failed_db.to_str().unwrap(),
                epoch: 1,
                replicated_wake: false,
                vfs: None,
            },
        ))
        .unwrap();
    runtime.block_on(
        failed
            .slot()
            .turn(|worker| native_cell_fetch(worker, &failed_scope, "throw")),
    );
    assert!(runtime.block_on(failed.release(&failed_scope)).is_err());
    #[cfg(target_os = "linux")]
    for fd in std::fs::read_dir("/proc/self/fd").unwrap().flatten() {
        if let Ok(path) = std::fs::read_link(fd.path()) {
            assert!(
                !path.starts_with(&failed_db),
                "throwing dispose left its SQLite descriptor open beside a live cell"
            );
        }
    }
    drop(failed);
    real_cells.reap_empty();
    assert_eq!(
        real_cells.live(),
        1,
        "the co-resident cell still owns the isolate"
    );
    assert_eq!(keeper.slot().heap_id(), keeper_heap);
    let _: String = runtime.block_on(
        keeper
            .slot()
            .turn(|worker| native_cell_fetch(worker, &first_scope, "first")),
    );
    runtime.block_on(keeper.release(&first_scope)).unwrap();
    drop(keeper);
    real_cells.reap_empty();
    assert!(
        real_cells.is_drained(),
        "failed cell release must poison its heap"
    );
    real_cells.retire_all();
    real_cells.reap_empty();
    assert!(real_cells.is_drained());
    // Termination makes only empty-cell retention ineligible; a resident sibling
    // can still share the realm, and the heap is freed once both reservations drain.
    let terminated_config = Arc::new(WorkerConfig::new(WorkerConfigOptions {
        src: "export default {fetch(){while(true){}}}".into(),
        script_name: "terminated-retention".into(),
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
        modules: vec![],
        compat: Default::default(),
    }));
    let terminated = Pool::new(
        PoolLimits {
            grow_at: 2,
            shrink_under: 1,
            max_stateless: 1,
            max_requests: None,
            max_cells: 2,
        },
        Duration::from_millis(10),
        Box::new(move || Worker::load_config(terminated_config.clone())),
    );
    let resident = terminated.place_cell().unwrap();
    let terminated_heap = resident.slot().heap_id();
    runtime.block_on(resident.slot().turn(|worker| {
        let (send, mut receive) = tokio::sync::oneshot::channel();
        let (entry, ops) = worker.turn_begin(
            celld::WorkerJob::Fetch {
                queued_at: std::time::Instant::now(),
                entrypoint: None,
                invocation_limits: Some(celld::WorkerInvocationLimits {
                    cpu_ms: Some(1),
                    sub_requests: None,
                }),
                url: "http://test/terminate".into(),
                method: "GET".into(),
                body: Vec::new().into(),
                headers: vec![],
                request_id: None,
                tail_report: None,
                reply: send,
            },
            None,
        );
        assert!(ops.is_empty());
        if let Some(mut entry) = entry {
            entry.abandon();
        }
        assert!(
            receive.try_recv().unwrap().is_err(),
            "CPU-limited request must fail"
        );
    }));
    let sibling = terminated.place_cell().unwrap();
    assert_eq!(
        sibling.slot().heap_id(),
        terminated_heap,
        "termination must not condemn a live cell slot"
    );
    drop(sibling);
    drop(resident);
    terminated.reap_empty();
    assert!(
        terminated.is_drained(),
        "a terminated heap must not be retained empty"
    );

    // An errored ESM graph must not survive an empty-pool maintenance pass.
    let broken_config=Arc::new(WorkerConfig::new(WorkerConfigOptions {
        src: "export default {async fetch(){try{await import('./broken.js')}catch{} return new Response('ok')}}".into(),
        script_name: "broken-retention".into(), do_classes: vec![], bindings: vec![],
        r2_bindings: vec![], d1_bindings: vec![], kv_bindings: vec![], queue_bindings: vec![],
        queue_consumers: vec![], workflow_bindings: vec![], vars: vec![], node: "test".into(),
        modules: vec![("broken.js".into(), celld::engine_api::ModuleSource::EsModule("throw new Error('broken graph')".into()))], compat: Default::default(),
    }));
    let stateless_config = broken_config.clone();
    let broken = Pool::new(
        PoolLimits {
            grow_at: 2,
            shrink_under: 1,
            max_stateless: 1,
            max_requests: None,
            max_cells: 2,
        },
        Duration::from_millis(10),
        Box::new(move || Worker::load_config(broken_config.clone())),
    );
    let residency = broken.place_cell().unwrap();
    runtime.block_on(residency.slot().turn(|worker| {
        let (send, mut receive) = tokio::sync::oneshot::channel();
        let (entry, ops) = worker.turn_begin(
            celld::WorkerJob::Fetch {
                queued_at: std::time::Instant::now(),
                entrypoint: None,
                invocation_limits: None,
                url: "http://test/".into(),
                method: "GET".into(),
                body: Vec::new().into(),
                headers: vec![],
                request_id: None,
                tail_report: None,
                reply: send,
            },
            None,
        );
        assert!(ops.is_empty());
        if let Some(mut entry) = entry {
            for _ in 0..100 {
                if entry.finished() {
                    break;
                }
                assert!(worker.turn_poll(&mut entry).is_empty());
            }
            assert!(entry.finished());
        }
        assert_eq!(receive.try_recv().unwrap().unwrap().status, 200);
    }));
    let sibling = broken.place_cell().unwrap();
    assert_eq!(
        sibling.slot().heap_id(),
        residency.slot().heap_id(),
        "a caught import failure must not retire a live cell isolate"
    );
    drop(sibling);
    drop(residency);
    broken.reap_empty();
    assert!(broken.is_drained(), "failed modules must not be retained");

    let stateless = Pool::new(
        PoolLimits {
            grow_at: 2,
            shrink_under: 1,
            max_stateless: 1,
            max_requests: None,
            max_cells: 1,
        },
        Duration::from_millis(10),
        Box::new(move || Worker::load_config(stateless_config.clone())),
    );
    let first = stateless.admit(false).unwrap();
    let heap = first.slot().heap_id();
    runtime.block_on(first.slot().turn(|worker| native_worker_fetch(worker, "/")));
    drop(first);
    let second = stateless.admit(false).unwrap();
    assert_eq!(
        second.slot().heap_id(),
        heap,
        "caught optional imports must not rebuild stateless workers"
    );
    runtime.block_on(
        second
            .slot()
            .turn(|worker| native_worker_fetch(worker, "/")),
    );
    drop(second);
    stateless.retire_all();
    let replacement = make_pool();
    replacement.warm().unwrap();
    assert!(replacement.admit(false).is_ok());
    replacement.retire_all();
    assert!(replacement.is_drained());
}

fn native_cell_fetch(worker: &mut Worker, scope: &str, name: &str) -> String {
    use celld::js::CellJob;
    let (send, mut receive) = tokio::sync::oneshot::channel();
    let (entry, ops) = worker.turn_begin_cell(
        CellJob::Fetch {
            request_id: None,
            scope: scope.into(),
            name: Some(name.into()),
            url: "http://probe/".into(),
            method: "GET".into(),
            body: Vec::new().into(),
            headers: vec![],
            reply: send,
            order: None,
        },
        None,
    );
    assert!(ops.is_empty());
    if let Some(mut entry) = entry {
        for _ in 0..100 {
            if entry.finished() {
                break;
            }
            assert!(worker.turn_poll(&mut entry).is_empty());
        }
        assert!(entry.finished());
    }
    let response = receive.try_recv().unwrap().unwrap();
    assert_eq!(response.status, 200);
    String::from_utf8(response.body).unwrap()
}

fn native_worker_fetch(worker: &mut Worker, path: &str) -> String {
    let (send, mut receive) = tokio::sync::oneshot::channel();
    let (entry, ops) = worker.turn_begin(
        celld::WorkerJob::Fetch {
            queued_at: std::time::Instant::now(),
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
    assert!(ops.is_empty());
    if let Some(mut entry) = entry {
        for _ in 0..100 {
            if entry.finished() {
                break;
            }
            assert!(worker.turn_poll(&mut entry).is_empty());
        }
        assert!(entry.finished());
    }
    let response = receive.try_recv().unwrap().unwrap();
    assert_eq!(response.status, 200);
    String::from_utf8(response.body).unwrap()
}
