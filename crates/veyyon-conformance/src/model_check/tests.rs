//! WHY: these suites defend the model checker itself and the three machines it
//! is pointed at. The class they close is a checker that agrees with anything:
//! an invariant that cannot fail, a dead end mistaken for an ending, a search
//! that stopped early and reported a pass, and a model that explores nothing.
//! Each machine therefore carries switches that inject its own defect, and
//! every switch is asserted to produce one named outcome.
//!
//! What they do not catch: liveness. Every property here is a predicate over a
//! single state, so "the queue eventually drains" is out of reach, and the
//! machines are finite by construction — proved for four nodes and two turns,
//! not for every size.

use super::{
	Budget, Invariant, Model, Outcome, check, lifecycle,
	lifecycle::{Call, Event, Lifecycle, Phase},
	locks,
	locks::{Mesh, MeshAction, order_inversions},
	session,
	session::{Tree, TreeAction, TreeState},
};

/// A machine with nowhere to start, which every invariant is vacuously true of.
struct Unreachable;

impl Model for Unreachable {
	type Action = ();
	type State = u8;

	fn initial(&self) -> Vec<u8> {
		Vec::new()
	}

	fn steps(&self, _state: &u8) -> Vec<((), u8)> {
		Vec::new()
	}

	fn is_terminal(&self, _state: &u8) -> bool {
		true
	}
}

/// A machine that never stops producing new states.
struct Unbounded;

impl Model for Unbounded {
	type Action = u32;
	type State = u32;

	fn initial(&self) -> Vec<u32> {
		vec![0]
	}

	fn steps(&self, state: &u32) -> Vec<(u32, u32)> {
		vec![(state + 1, state + 1)]
	}

	fn is_terminal(&self, _state: &u32) -> bool {
		false
	}
}

#[test]
fn a_model_that_explores_nothing_is_not_a_pass() {
	let report =
		check(&Unreachable, &[Invariant { name: "never", predicate: |_| false }], Budget::DEFAULT);

	assert_eq!(report.explored, 0);
	assert_eq!(report.outcome, Outcome::Holds);
	assert!(!report.is_success(), "an empty exploration must not report success");
}

#[test]
fn an_exhausted_budget_is_not_a_pass() {
	let report = check(&Unbounded, &[], Budget { max_states: 32 });

	assert_eq!(report.outcome, Outcome::BudgetExhausted { explored: 32 });
	assert!(!report.is_success());
	assert!(report.trace().is_none());
}

#[test]
fn the_production_lifecycle_holds_every_contract() {
	let report = check(&Lifecycle::PRODUCTION, &lifecycle::INVARIANTS, Budget::DEFAULT);

	assert!(report.is_success(), "production lifecycle broke: {:?}", report.outcome);
	assert!(report.explored >= 8, "explored only {} states", report.explored);
}

#[test]
fn each_lifecycle_defect_names_its_own_invariant() {
	let effects_before_validation =
		Lifecycle { validation_gates_effects: false, ..Lifecycle::PRODUCTION };
	let settles_twice = Lifecycle { settlement_is_final: false, ..Lifecycle::PRODUCTION };
	let cancel_never_settles = Lifecycle { cancellation_settles: false, ..Lifecycle::PRODUCTION };

	let broken = check(&effects_before_validation, &lifecycle::INVARIANTS, Budget::DEFAULT);
	let Outcome::Violated { invariant, trace } = broken.outcome else {
		panic!("expected a violation, got {:?}", broken.outcome);
	};
	assert_eq!(invariant, "no-side-effect-before-validation");
	assert_eq!(trace.len(), 1, "the shortest path to an unvalidated effect is one action");
	assert_eq!(trace.actions().copied().collect::<Vec<_>>(), vec![Event::Effect]);
	assert_eq!(*trace.last(), Call {
		phase:       Phase::Requested,
		effects:     1,
		settlements: 0,
	});

	let twice = check(&settles_twice, &lifecycle::INVARIANTS, Budget::DEFAULT);
	let Outcome::Violated { invariant, trace } = twice.outcome else {
		panic!("expected a violation, got {:?}", twice.outcome);
	};
	assert_eq!(invariant, "settles-exactly-once");
	assert_eq!(trace.last().settlements, 2);

	let stuck = check(&cancel_never_settles, &lifecycle::INVARIANTS, Budget::DEFAULT);
	let Outcome::Deadlock { trace } = stuck.outcome else {
		panic!("expected a deadlock, got {:?}", stuck.outcome);
	};
	assert_eq!(trace.last().phase, Phase::Cancelling);
	assert_eq!(trace.last().settlements, 0, "a wedged call owes its caller a settlement");
}

#[test]
fn every_terminal_lifecycle_state_has_settled_once() {
	// The invariant is checked by `check` at every reachable state; this pins
	// the other half, that terminal states are reached at all and that the
	// enumeration below is not empty.
	let production = Lifecycle::PRODUCTION;
	let mut reached = Vec::new();
	let mut frontier = production.initial();
	while let Some(call) = frontier.pop() {
		if reached.contains(&call) {
			continue;
		}
		reached.push(call);
		for (_, next) in production.steps(&call) {
			frontier.push(next);
		}
	}

	let terminal: Vec<Call> = reached
		.iter()
		.copied()
		.filter(|call| production.is_terminal(call))
		.collect();
	assert!(!terminal.is_empty(), "the lifecycle never finishes");
	for call in terminal {
		assert_eq!(call.settlements, 1, "{call:?} is terminal without settling exactly once");
	}
}

#[test]
fn plans_that_share_one_order_cannot_deadlock() {
	let mesh = Mesh::new(vec![vec![1, 2], vec![1, 2], vec![2]]);

	assert!(order_inversions(&mesh.plans).is_empty());
	let report = check(&mesh, &locks::INVARIANTS, Budget::DEFAULT);
	assert!(report.is_success(), "consistent order deadlocked: {:?}", report.outcome);
}

#[test]
fn an_inverted_pair_of_plans_deadlocks_and_says_who_holds_what() {
	let mesh = Mesh::new(vec![vec![1, 2], vec![2, 1]]);

	assert_eq!(order_inversions(&mesh.plans), vec![(1, 2)]);
	let report = check(&mesh, &locks::INVARIANTS, Budget::DEFAULT);
	let Outcome::Deadlock { trace } = report.outcome else {
		panic!("expected a deadlock, got {:?}", report.outcome);
	};
	assert_eq!(trace.len(), 2, "two acquisitions wedge this mesh");
	assert_eq!(trace.last().holders.get(&1), Some(&0));
	assert_eq!(trace.last().holders.get(&2), Some(&1));
	for action in trace.actions() {
		assert!(matches!(action, MeshAction::Acquire { .. }), "{action:?} is not an acquisition");
	}
}

#[test]
fn a_deadlocking_mesh_always_has_an_order_inversion() {
	// The static argument claims only one direction, so that is the direction
	// swept: a mesh with no inversion must not deadlock, over every pair of
	// two-lock plans drawn from three locks. The sweep is derived here rather
	// than listed, so a fourth lock changes the space by changing one bound.
	let locks_available: Vec<u8> = vec![1, 2, 3];
	let plans: Vec<Vec<u8>> = locks_available
		.iter()
		.flat_map(|first| {
			locks_available
				.iter()
				.filter(move |second| *second != first)
				.map(move |second| vec![*first, *second])
		})
		.collect();
	assert_eq!(plans.len(), 6);

	let mut deadlocks = 0;
	for left in &plans {
		for right in &plans {
			let mesh = Mesh::new(vec![left.clone(), right.clone()]);
			let report = check(&mesh, &locks::INVARIANTS, Budget::DEFAULT);
			let wedged = matches!(report.outcome, Outcome::Deadlock { .. });
			if wedged {
				deadlocks += 1;
				assert!(
					!order_inversions(&mesh.plans).is_empty(),
					"{left:?} and {right:?} deadlock with no order inversion"
				);
			} else {
				assert!(report.is_success(), "{left:?} and {right:?}: {:?}", report.outcome);
			}
		}
	}
	assert!(deadlocks > 0, "the sweep never reached a deadlock, so it proved nothing");
}

#[test]
fn a_release_that_leaks_a_lock_is_caught() {
	let leaky = Mesh { plans: vec![vec![1, 2]], release_frees_every_lock: false };

	let report = check(&leaky, &locks::INVARIANTS, Budget::DEFAULT);
	let Outcome::Violated { invariant, trace } = report.outcome else {
		panic!("expected a violation, got {:?}", report.outcome);
	};
	assert_eq!(invariant, "a-finished-worker-holds-nothing");
	assert_eq!(trace.last().holders.len(), 1, "exactly the leaked lock is still held");
}

#[test]
fn a_worker_with_no_locks_releases_without_reaching_for_one() {
	// An empty plan holds nothing when it releases, and the leak switch takes
	// the first held lock away. Together those are an empty-list index, so both
	// meshes have to answer rather than panic — and the answers differ, because
	// the second worker in the leaky mesh really does leak lock 1.
	let sound =
		Mesh { plans: vec![Vec::new(), vec![1]], release_frees_every_lock: true };
	assert!(check(&sound, &locks::INVARIANTS, Budget::DEFAULT).is_success());

	let leaky =
		Mesh { plans: vec![Vec::new(), vec![1]], release_frees_every_lock: false };
	let report = check(&leaky, &locks::INVARIANTS, Budget::DEFAULT);
	let Outcome::Violated { invariant, trace } = report.outcome else {
		panic!("expected the leak to be caught, got {:?}", report.outcome);
	};
	assert_eq!(invariant, "a-finished-worker-holds-nothing");
	assert_eq!(trace.last().holders.get(&1), Some(&1), "worker 1 leaked the lock it took");
}

#[test]
fn the_production_session_tree_holds_every_contract() {
	let report = check(&Tree::PRODUCTION, &session::INVARIANTS, Budget::DEFAULT);

	assert!(report.is_success(), "production tree broke: {:?}", report.outcome);
	assert!(report.explored > 100, "explored only {} states", report.explored);
}

#[test]
fn each_session_defect_names_its_own_invariant() {
	let cyclic = Tree { fork_links_to_parent: false, ..Tree::PRODUCTION };
	let lossy = Tree { compaction_keeps_a_turn: false, ..Tree::PRODUCTION };

	let broken = check(&cyclic, &session::INVARIANTS, Budget::DEFAULT);
	let Outcome::Violated { invariant, trace } = broken.outcome else {
		panic!("expected a violation, got {:?}", broken.outcome);
	};
	assert_eq!(invariant, "every-node-reaches-the-root");
	assert_eq!(trace.actions().copied().collect::<Vec<_>>(), vec![TreeAction::Fork]);

	let emptied = check(&lossy, &session::INVARIANTS, Budget::DEFAULT);
	let Outcome::Violated { invariant, trace } = emptied.outcome else {
		panic!("expected a violation, got {:?}", emptied.outcome);
	};
	assert_eq!(invariant, "compaction-leaves-a-turn");
	assert_eq!(
		trace.actions().copied().collect::<Vec<_>>(),
		vec![TreeAction::Append, TreeAction::Compact],
		"a turn must exist before a compaction can lose it"
	);
}

#[test]
fn the_reachability_walk_terminates_on_a_cycle() {
	// A predicate checked against broken states must not follow one forever: a
	// two-node cycle would hang the checker rather than fail it, and a hang is
	// the failure mode a value assertion cannot see. Reaching the assertion at
	// all is the proof.
	let cycle = TreeState {
		parents:   vec![0, 2, 1],
		turns:     vec![0; 3],
		compacted: vec![false; 3],
		active:    0,
	};
	let reaches_root = session::INVARIANTS
		.iter()
		.find(|invariant| invariant.name == "every-node-reaches-the-root");

	let reaches_root = reaches_root.expect("the reachability invariant is registered");
	assert!(!(reaches_root.predicate)(&cycle));
	assert!((reaches_root.predicate)(&TreeState::root()));
}
