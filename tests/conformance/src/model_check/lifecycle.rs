//! The tool-call lifecycle, as a machine.
//!
//! Two contracts from issue #877 are about a call's whole history rather than
//! any one moment of it: schema rejection happens before any side effect, and
//! every started call settles exactly once. A single execution cannot show
//! either one, because the orders that break them are rare and a case picks one
//! order. This machine states the lifecycle declaratively and the checker
//! visits every order.
//!
//! [`Lifecycle`] carries three switches, all true in [`Lifecycle::PRODUCTION`].
//! They exist so the invariants can be proved capable of failing: a suite that
//! only ever checks the correct machine cannot tell a real proof from a
//! predicate that is true by accident. Turning one off injects the
//! corresponding defect and the checker must report that exact invariant. They
//! are not configuration of anything shipped.

use super::{Invariant, Model};

/// The furthest a call can get in this machine's accounting of side effects.
///
/// The contract is about zero versus more than zero, so two is enough to
/// express it, and a cap is what keeps the state space finite.
pub const EFFECT_CAP: u8 = 2;

/// The furthest a call can get in its accounting of settlements. Two is enough
/// to make "more than once" observable.
pub const SETTLEMENT_CAP: u8 = 2;

/// Where a call is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
	/// Arguments arrived and nothing has looked at them.
	Requested,
	/// The schema refused the arguments. Terminal.
	Rejected,
	/// The schema accepted the arguments and execution has not begun.
	Validated,
	/// Executing, and free to produce side effects.
	Running,
	/// Cancellation was requested while running. Not an end: the call still
	/// owes exactly one settlement.
	Cancelling,
	/// Settled. Terminal.
	Settled,
}

/// A call's whole observable state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Call {
	pub phase:       Phase,
	/// Side effects performed, saturating at [`EFFECT_CAP`].
	pub effects:     u8,
	/// Settlements delivered, saturating at [`SETTLEMENT_CAP`].
	pub settlements: u8,
}

impl Call {
	/// A call that has just arrived.
	#[must_use]
	pub const fn requested() -> Self {
		Self { phase: Phase::Requested, effects: 0, settlements: 0 }
	}

	/// The same call in `phase`.
	const fn to(self, phase: Phase) -> Self {
		Self { phase, ..self }
	}

	/// The same call one side effect further along.
	const fn with_effect(self) -> Self {
		Self {
			effects: if self.effects >= EFFECT_CAP {
				EFFECT_CAP
			} else {
				self.effects + 1
			},
			..self
		}
	}

	/// The same call, settled in `phase`.
	const fn settled_in(self, phase: Phase) -> Self {
		let settlements = if self.settlements >= SETTLEMENT_CAP {
			SETTLEMENT_CAP
		} else {
			self.settlements + 1
		};
		Self { phase, settlements, ..self }
	}
}

/// What happened to a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Event {
	/// The schema accepted the arguments.
	Validate,
	/// The schema refused the arguments.
	Reject,
	/// Execution began.
	Start,
	/// A side effect was performed.
	Effect,
	/// Execution finished successfully.
	Complete,
	/// Execution finished with an error.
	Fail,
	/// The deadline elapsed.
	Timeout,
	/// Cancellation was requested.
	Cancel,
}

/// The lifecycle machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lifecycle {
	/// Whether validation gates side effects. False lets a `Requested` or
	/// `Rejected` call perform one, which is the defect
	/// `no-side-effect-before-validation` exists to catch.
	pub validation_gates_effects: bool,
	/// Whether a settled call is done. False lets it settle again, which is
	/// the defect `settles-exactly-once` exists to catch.
	pub settlement_is_final:      bool,
	/// Whether a cancelled call still settles. False leaves `Cancelling` with
	/// no successor, which the checker reports as a deadlock: the caller waits
	/// forever for a result that will never come.
	pub cancellation_settles:     bool,
}

impl Lifecycle {
	/// The machine as the product is contracted to behave.
	pub const PRODUCTION: Self = Self {
		validation_gates_effects: true,
		settlement_is_final:      true,
		cancellation_settles:     true,
	};
}

impl Default for Lifecycle {
	fn default() -> Self {
		Self::PRODUCTION
	}
}

/// The lifecycle contracts, named as contracts.
pub static INVARIANTS: [Invariant<Call>; 3] = [
	Invariant {
		name:      "no-side-effect-before-validation",
		predicate: |call| {
			call.effects == 0
				|| matches!(
					call.phase,
					Phase::Validated | Phase::Running | Phase::Cancelling | Phase::Settled
				)
		},
	},
	Invariant { name: "settles-exactly-once", predicate: |call| call.settlements <= 1 },
	Invariant {
		name:      "a-finished-call-has-settled",
		predicate: |call| {
			!matches!(call.phase, Phase::Settled | Phase::Rejected) || call.settlements == 1
		},
	},
];

impl Model for Lifecycle {
	type Action = Event;
	type State = Call;

	fn initial(&self) -> Vec<Call> {
		vec![Call::requested()]
	}

	fn steps(&self, call: &Call) -> Vec<(Event, Call)> {
		let call = *call;
		match call.phase {
			Phase::Requested => {
				let mut steps = vec![
					(Event::Validate, call.to(Phase::Validated)),
					(Event::Reject, call.settled_in(Phase::Rejected)),
				];
				if !self.validation_gates_effects {
					steps.push((Event::Effect, call.with_effect()));
				}
				steps
			},
			Phase::Rejected => {
				if self.validation_gates_effects {
					Vec::new()
				} else {
					vec![(Event::Effect, call.with_effect())]
				}
			},
			Phase::Validated => vec![
				(Event::Start, call.to(Phase::Running)),
				(Event::Cancel, call.settled_in(Phase::Settled)),
			],
			Phase::Running => vec![
				(Event::Effect, call.with_effect()),
				(Event::Complete, call.settled_in(Phase::Settled)),
				(Event::Fail, call.settled_in(Phase::Settled)),
				(Event::Timeout, call.settled_in(Phase::Settled)),
				(Event::Cancel, call.to(Phase::Cancelling)),
			],
			Phase::Cancelling => {
				if self.cancellation_settles {
					vec![
						(Event::Complete, call.settled_in(Phase::Settled)),
						(Event::Fail, call.settled_in(Phase::Settled)),
					]
				} else {
					Vec::new()
				}
			},
			Phase::Settled => {
				if self.settlement_is_final {
					Vec::new()
				} else {
					vec![(Event::Complete, call.settled_in(Phase::Settled))]
				}
			},
		}
	}

	fn is_terminal(&self, call: &Call) -> bool {
		matches!(call.phase, Phase::Settled | Phase::Rejected)
	}
}
