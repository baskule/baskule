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
    let builds = Arc::new(AtomicUsize::new(0));
    let make_pool = || {
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
                Worker::load_config(Arc::new(WorkerConfig::new(WorkerConfigOptions {
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
                })))
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
    assert!(empty_cells.is_drained(), "empty cell pools must reach zero");
    let replacement = make_pool();
    replacement.warm().unwrap();
    assert!(replacement.admit(false).is_ok());
    replacement.retire_all();
    assert!(replacement.is_drained());
}
