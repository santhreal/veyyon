//! Lock acquisition, as a machine.
//!
//! The agent mesh has workers that take more than one lock. Whether a set of
//! acquisition plans can deadlock is not a property of any one run: the
//! schedule that wedges them is one interleaving out of many, and a test that
//! happens to pass took a different one. The machine below enumerates the
//! interleavings, and a wedged state is exactly a state with no successor that
//! is not terminal, which is what the checker already reports.
//!
//! [`order_inversions`] answers the same question a second way, and the two are
//! independent on purpose. It is the textbook argument — plans that take their
//! locks in one consistent order cannot form a cycle in the wait-for graph —
//! computed from the plans alone, without exploring anything. A suite that
//! asserts both agree cannot be fooled by a bug in either: the enumeration
//! would have to miss the same interleaving the static argument mis-classifies.

use std::collections::{BTreeMap, BTreeSet};

use super::{Invariant, Model};

/// A lock, named by a small integer because a model does not need strings.
pub type LockId = u8;

/// A worker, by index into [`Mesh::plans`].
pub type WorkerId = usize;

/// A set of workers, each with an ordered plan of locks to hold at once.
///
/// A worker takes every lock in its plan, in order, and holds all of them until
/// it releases them together. That is the shape that deadlocks; a worker that
/// takes one lock at a time cannot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mesh {
	pub plans:                    Vec<Vec<LockId>>,
	/// Whether releasing frees every lock the worker holds. False leaks the
	/// first one, which is the defect `a-finished-worker-holds-nothing` exists
	/// to catch, and which in production is a lock guard dropped on one path
	/// and forgotten on another.
	pub release_frees_every_lock: bool,
}

impl Mesh {
	/// A mesh of `plans` that behaves as the product is contracted to.
	#[must_use]
	pub const fn new(plans: Vec<Vec<LockId>>) -> Self {
		Self { plans, release_frees_every_lock: true }
	}

	/// How many workers there are.
	#[must_use]
	pub const fn workers(&self) -> usize {
		self.plans.len()
	}
}

/// Who holds what, and how far along each worker is.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct MeshState {
	/// Locks of its own plan each worker has taken.
	pub progress: Vec<usize>,
	/// Workers that have released and stopped.
	pub done:     Vec<bool>,
	/// The current holder of each held lock.
	pub holders:  BTreeMap<LockId, WorkerId>,
}

impl MeshState {
	/// Locks `worker` currently holds.
	fn held_by(&self, worker: WorkerId) -> Vec<LockId> {
		self
			.holders
			.iter()
			.filter(|(_, holder)| **holder == worker)
			.map(|(lock, _)| *lock)
			.collect()
	}
}

/// What a worker did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MeshAction {
	Acquire { worker: WorkerId, lock: LockId },
	Release { worker: WorkerId },
}

/// The lock contracts that hold whatever the plans are.
pub static INVARIANTS: [Invariant<MeshState>; 1] = [Invariant {
	name:      "a-finished-worker-holds-nothing",
	predicate: |state| {
		!state
			.holders
			.values()
			.any(|holder| state.done.get(*holder).copied().unwrap_or(false))
	},
}];

impl Model for Mesh {
	type Action = MeshAction;
	type State = MeshState;

	fn initial(&self) -> Vec<MeshState> {
		vec![MeshState {
			progress: vec![0; self.workers()],
			done:     vec![false; self.workers()],
			holders:  BTreeMap::new(),
		}]
	}

	fn steps(&self, state: &MeshState) -> Vec<(MeshAction, MeshState)> {
		let mut steps = Vec::new();
		for (worker, plan) in self.plans.iter().enumerate() {
			if state.done[worker] {
				continue;
			}
			if let Some(lock) = plan.get(state.progress[worker]).copied() {
				if state.holders.contains_key(&lock) {
					continue;
				}
				let mut next = state.clone();
				next.holders.insert(lock, worker);
				next.progress[worker] += 1;
				steps.push((MeshAction::Acquire { worker, lock }, next));
			} else {
				let mut next = state.clone();
				let mut held = next.held_by(worker);
				if !self.release_frees_every_lock && !held.is_empty() {
					held.remove(0);
				}
				for lock in held {
					next.holders.remove(&lock);
				}
				next.done[worker] = true;
				steps.push((MeshAction::Release { worker }, next));
			}
		}
		steps
	}

	fn is_terminal(&self, state: &MeshState) -> bool {
		state.done.iter().all(|done| *done)
	}
}

/// The lock pairs two plans disagree about the order of.
///
/// A pair `(a, b)` with `a < b` is reported when some plan takes `a` before `b`
/// and some plan takes `b` before `a`. An empty answer is the sufficient
/// condition for freedom from deadlock in this model: the plans share one
/// consistent order, so the wait-for graph is acyclic.
///
/// The converse does not hold, and the emptiness of this answer is the only
/// claim it makes. Plans can disagree about an order and still never deadlock,
/// because the disagreement needs a schedule that reaches it.
#[must_use]
pub fn order_inversions(plans: &[Vec<LockId>]) -> Vec<(LockId, LockId)> {
	let mut precedes: BTreeSet<(LockId, LockId)> = BTreeSet::new();
	for plan in plans {
		for (index, earlier) in plan.iter().enumerate() {
			for later in &plan[index + 1..] {
				if earlier != later {
					precedes.insert((*earlier, *later));
				}
			}
		}
	}

	let mut inversions: BTreeSet<(LockId, LockId)> = BTreeSet::new();
	for (earlier, later) in &precedes {
		if precedes.contains(&(*later, *earlier)) {
			inversions.insert((*earlier.min(later), *earlier.max(later)));
		}
	}
	inversions.into_iter().collect()
}
