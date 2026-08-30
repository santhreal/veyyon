//! Explicit-state model checking: exhausting a state machine's reachable
//! states and reporting the shortest way to a broken one.
//!
//! A conformance case drives one execution. That is the wrong instrument for a
//! contract like "every started tool call settles exactly once", because the
//! interleaving that breaks it is one of a few thousand and a case picks one.
//! The models here enumerate all of them: breadth-first over the transition
//! relation, checking every named invariant at every reachable state.
//!
//! Three rules keep the answer honest.
//!
//! - **A model is not the implementation.** These machines are the independent
//!   oracle the design document asks for: a declarative statement of the
//!   contract, written from the contract and not from the code, so a checker
//!   that agrees with a buggy implementation is impossible. They never call
//!   production code.
//! - **A dead end is a failure, not an end.** A state with no successor is a
//!   deadlock unless the model says it is terminal, so [`Model::is_terminal`]
//!   is a required method rather than a default of `false`. A default would
//!   turn every leaf into an accepted stop and hide exactly the class —
//!   mutually blocked workers — this module exists to find.
//! - **An unfinished search is not a passing search.** Hitting
//!   [`Budget::max_states`] reports [`Outcome::BudgetExhausted`], and
//!   [`Report::is_success`] refuses it, along with a search that explored
//!   nothing at all.
//!
//! Breadth-first is the choice that makes a counterexample usable: the first
//! violating state found is at minimal depth, so the trace is the shortest
//! sequence of actions that reaches it, and there is nothing to reduce
//! afterwards.
//!
//! # What this does not catch
//!
//! Only safety properties. An invariant is a predicate over a single state, so
//! "the queue eventually drains" — a liveness property needing a cycle
//! argument over infinite runs — is out of reach here; the bounded-termination
//! contracts are asserted by the executing case instead. The models are also
//! finite by construction (counts saturate, worker and lock counts are small),
//! so they prove the contract for the modelled size and not for every size.

pub mod lifecycle;
pub mod locks;
pub mod session;

#[cfg(test)]
mod tests;

use std::{
	collections::{BTreeMap, VecDeque},
	fmt,
};

/// A finite state machine stated as its transition relation.
pub trait Model {
	/// A point in the machine. `Ord` because the visited set is a `BTreeMap`:
	/// a hash would make the exploration order depend on a random seed, and a
	/// counterexample that changes between runs is a counterexample nobody can
	/// bisect.
	type State: Clone + Ord;

	/// What a transition is called, for the counterexample trace.
	type Action: Clone + Ord;

	/// Where the machine may start. More than one initial state is normal: a
	/// model of a resumed session starts from every persisted shape it accepts.
	fn initial(&self) -> Vec<Self::State>;

	/// Every transition out of `state`, as the action that fires and the state
	/// it reaches.
	fn steps(&self, state: &Self::State) -> Vec<(Self::Action, Self::State)>;

	/// Whether `state` is an accepted stopping point. A state with no
	/// successors that answers `false` here is reported as a deadlock.
	fn is_terminal(&self, state: &Self::State) -> bool;
}

/// A named predicate over a single state.
///
/// The name is what a failure reports, so it is written as the contract rather
/// than as the code: `settles-exactly-once`, not `check_settlements`.
pub struct Invariant<S> {
	pub name:      &'static str,
	pub predicate: fn(&S) -> bool,
}

impl<S> fmt::Debug for Invariant<S> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Invariant")
			.field("name", &self.name)
			.finish_non_exhaustive()
	}
}

/// How much exploration a check may spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
	pub max_states: usize,
}

impl Budget {
	/// Enough for every model in this module by two orders of magnitude, and
	/// small enough that a model whose state space accidentally became
	/// unbounded reports exhaustion in under a second instead of consuming the
	/// machine.
	pub const DEFAULT: Self = Self { max_states: 200_000 };
}

impl Default for Budget {
	fn default() -> Self {
		Self::DEFAULT
	}
}

/// One transition of a counterexample.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step<A, S> {
	pub action: A,
	pub state:  S,
}

/// The shortest path from an initial state to the state that broke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trace<A, S> {
	pub initial: S,
	pub steps:   Vec<Step<A, S>>,
}

impl<A, S> Trace<A, S> {
	/// How many transitions the trace fires.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.steps.len()
	}

	/// Whether the initial state itself is the counterexample.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.steps.is_empty()
	}

	/// The state the trace ends in: the one that violated the invariant, or
	/// the one with nothing left to do.
	#[must_use]
	pub fn last(&self) -> &S {
		self.steps.last().map_or(&self.initial, |step| &step.state)
	}

	/// The actions in order, which is the part a report prints.
	pub fn actions(&self) -> impl Iterator<Item = &A> {
		self.steps.iter().map(|step| &step.action)
	}
}

/// How a check ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome<A, S> {
	/// Every reachable state satisfied every invariant, and every dead end was
	/// declared terminal.
	Holds,
	/// A reachable state broke `invariant`.
	Violated { invariant: &'static str, trace: Trace<A, S> },
	/// A reachable state has no successor and is not terminal.
	Deadlock { trace: Trace<A, S> },
	/// The search ran out of budget. Not a pass: the unexplored remainder is
	/// exactly where an unfound violation would be.
	BudgetExhausted { explored: usize },
}

/// What a check did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report<A, S> {
	/// Distinct states discovered.
	pub explored: usize,
	/// The greatest depth reached, in transitions from an initial state.
	pub depth:    usize,
	pub outcome:  Outcome<A, S>,
}

impl<A, S> Report<A, S> {
	/// Whether the model was proved, which requires that something was
	/// actually explored. A model whose `initial()` is empty explores nothing
	/// and vacuously satisfies every invariant; that is a broken model, not a
	/// verified one.
	#[must_use]
	pub const fn is_success(&self) -> bool {
		self.explored > 0 && matches!(self.outcome, Outcome::Holds)
	}

	/// The counterexample, when the outcome carries one.
	#[must_use]
	pub const fn trace(&self) -> Option<&Trace<A, S>> {
		match &self.outcome {
			Outcome::Violated { trace, .. } | Outcome::Deadlock { trace } => Some(trace),
			Outcome::Holds | Outcome::BudgetExhausted { .. } => None,
		}
	}
}

/// Explore every state `model` can reach, checking `invariants` at each one.
///
/// Invariants are checked when a state is dequeued rather than when it is
/// discovered, so the first violation reported is at minimal depth and its
/// trace is the shortest one.
pub fn check<M>(
	model: &M,
	invariants: &[Invariant<M::State>],
	budget: Budget,
) -> Report<M::Action, M::State>
where
	M: Model,
{
	let mut order: Vec<M::State> = Vec::new();
	let mut parent: Vec<Option<(usize, M::Action)>> = Vec::new();
	let mut depth_of: Vec<usize> = Vec::new();
	let mut seen: BTreeMap<M::State, usize> = BTreeMap::new();
	let mut queue: VecDeque<usize> = VecDeque::new();
	let mut deepest = 0;

	for state in model.initial() {
		if seen.contains_key(&state) {
			continue;
		}
		if order.len() >= budget.max_states {
			return exhausted(order.len(), deepest);
		}
		let index = order.len();
		seen.insert(state.clone(), index);
		order.push(state);
		parent.push(None);
		depth_of.push(0);
		queue.push_back(index);
	}

	while let Some(index) = queue.pop_front() {
		let state = order[index].clone();
		if let Some(broken) = invariants
			.iter()
			.find(|invariant| !(invariant.predicate)(&state))
		{
			let trace = trace_to(&order, &parent, index);
			return Report {
				explored: order.len(),
				depth:    deepest,
				outcome:  Outcome::Violated { invariant: broken.name, trace },
			};
		}

		let steps = model.steps(&state);
		if steps.is_empty() && !model.is_terminal(&state) {
			let trace = trace_to(&order, &parent, index);
			return Report {
				explored: order.len(),
				depth:    deepest,
				outcome:  Outcome::Deadlock { trace },
			};
		}

		for (action, next) in steps {
			if seen.contains_key(&next) {
				continue;
			}
			if order.len() >= budget.max_states {
				return exhausted(order.len(), deepest);
			}
			let child = order.len();
			seen.insert(next.clone(), child);
			order.push(next);
			parent.push(Some((index, action)));
			let depth = depth_of[index] + 1;
			depth_of.push(depth);
			deepest = deepest.max(depth);
			queue.push_back(child);
		}
	}

	Report { explored: order.len(), depth: deepest, outcome: Outcome::Holds }
}

/// The budget report, which is the same shape from both places that hit it.
const fn exhausted<A, S>(explored: usize, depth: usize) -> Report<A, S> {
	Report { explored, depth, outcome: Outcome::BudgetExhausted { explored } }
}

/// Walk the parent chain from `index` back to its initial state.
fn trace_to<A: Clone, S: Clone>(
	order: &[S],
	parent: &[Option<(usize, A)>],
	index: usize,
) -> Trace<A, S> {
	let mut steps = Vec::new();
	let mut at = index;
	while let Some((previous, action)) = parent[at].clone() {
		steps.push(Step { action, state: order[at].clone() });
		at = previous;
	}
	steps.reverse();
	Trace { initial: order[at].clone(), steps }
}
