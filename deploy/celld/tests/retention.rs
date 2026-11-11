use celld_logic::isolate::{
    admit, may_free, retire, IsolateLoad, Placement, PoolLimits, PoolLoad, Refusal,
};

fn pool(isolates: Vec<IsolateLoad>) -> PoolLoad {
    PoolLoad {
        isolates,
        limits: PoolLimits {
            grow_at: 2,
            shrink_under: 1,
            max_stateless: 4,
            max_requests: Some(8),
            max_cells: 2,
        },
    }
}

#[test]
fn idle_stateless_pool_shrinks_to_one_but_cell_pool_empties() {
    for floor in [0, 1] {
        let mut load = pool(vec![IsolateLoad::default(); 4]);
        for _ in 0..10 {
            if let Some(id) = retire(&load, floor) {
                load.isolates[id].retiring = true;
                assert!(may_free(&load.isolates[id]));
            }
        }
        assert_eq!(load.isolates.iter().filter(|i| !i.retiring).count(), floor);
    }
    assert_eq!(retire(&pool(vec![]), 1), None);
}

#[test]
fn retirement_preserves_hysteresis_and_housed_cells() {
    let mut load = pool(vec![IsolateLoad::default(); 2]);
    load.isolates[0].turns = 2;
    assert_eq!(retire(&load, 1), None);
    load.isolates[0].turns = 1;
    assert_eq!(retire(&load, 1), Some(1));
    load.isolates[1].cells = 1;
    assert_eq!(retire(&load, 1), Some(0));
    load.isolates[0].cells = 1;
    assert_eq!(retire(&load, 0), None);
}

#[test]
fn draining_isolates_do_not_count_toward_the_floor() {
    let mut load = pool(vec![IsolateLoad::default(); 2]);
    load.isolates[0].retiring = true;
    load.isolates[0].requests = 1;
    assert_eq!(retire(&load, 1), None);
    assert!(!may_free(&load.isolates[0]));
    load.isolates[0].requests = 0;
    assert!(may_free(&load.isolates[0]));
    load.isolates[0].turns = 1;
    assert!(!may_free(&load.isolates[0]));
    load.isolates[0].turns = 0;
    load.isolates[0].cells = 1;
    assert!(!may_free(&load.isolates[0]));
}

#[test]
fn pressure_uses_existing_capacity_without_growing_and_preserves_request_limits() {
    let mut load = pool(vec![IsolateLoad {
        turns: 2,
        ..Default::default()
    }]);
    assert_eq!(admit(&load, false), Ok(Placement::Grow));
    assert_eq!(admit(&load, true), Ok(Placement::Existing(0)));
    load.isolates[0].requests = 8;
    assert_eq!(admit(&load, false), Err(Refusal::NodeFull));
    assert_eq!(admit(&load, true), Err(Refusal::NodePressured));
}
