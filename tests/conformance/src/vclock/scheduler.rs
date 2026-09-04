//! Deterministic discrete-event scheduler over virtual time.
//!
//! # Event Ordering Specification and Tie-Breaking Rule
//!
//! The discrete-event scheduler guarantees strict total ordering of all events
//! across every runner and platform. The ordering key is the tuple:
//!
//! `(deadline, registration_sequence)`
//!
//! 1. **Primary Key — Deadline (`VirtualInstant`)**: Events with earlier
//!    deadlines always execute before events with later deadlines.
//! 2. **Secondary Key — Registration Sequence (`u64`)**: When two or more
//!    events are scheduled for the exact same [`VirtualInstant`], they are
//!    dispatched strictly in the order they were scheduled (FIFO).
//!
//! ## Justification for Fixed FIFO Rule over PRNG Tie-Breaking
//!
//! While a pseudo-random generator (such as [`crate::rng::Rng`]) can provide
//! seeded permutations, a fixed FIFO registration rule is preferred for the
//! conformance scheduler for four reasons:
//!
//! 1. **Causal Monotonicity**: An event scheduled earlier in source code or by
//!    a preceding event handler possesses causal precedence. FIFO preserves the
//!    natural causal timeline at discrete time boundaries.
//! 2. **Zero Seed Synchronization Overhead**: Conformance cases frequently
//!    interleave independent components. A fixed rule eliminates the risk of
//!    subsystem seed drift or order-dependent RNG consumption corrupting
//!    replays.
//! 3. **Exact Oracle Trace Stability**: Conformance assertions record exact
//!    event interleaving traces. Fixed tie-breaking guarantees that identical
//!    case construction yields identical execution traces forever.
//! 4. **No Weak Orderings**: Because every scheduled event increments a
//!    strictly monotonic sequence counter, no two events can ever compare
//!    equal.

use std::{fmt, time::Duration};

use serde::{Deserialize, Serialize};

use super::{FiredTimer, StepOverrunError, TimerId, VirtualClock, VirtualInstant};

/// An opaque identifier for a scheduled event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EventId(pub u64);

impl fmt::Display for EventId {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "event#{}", self.0)
	}
}

/// A trace entry representing an executed event in the deterministic trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ExecutedEvent {
	/// Unique event identifier.
	pub id:               EventId,
	/// The deadline this event was scheduled for.
	pub deadline:         VirtualInstant,
	/// The instant at which the event was executed by the scheduler.
	pub fired_at:         VirtualInstant,
	/// Opaque event label identifying the event variant or action.
	pub label:            u64,
	/// Monotonic registration sequence assigned at scheduling time.
	pub registration_seq: u64,
}

impl From<FiredTimer<u64>> for ExecutedEvent {
	fn from(timer: FiredTimer<u64>) -> Self {
		Self {
			id:               EventId(timer.id.0),
			deadline:         timer.deadline,
			fired_at:         timer.fired_at,
			label:            timer.payload,
			registration_seq: timer.registration_seq,
		}
	}
}

/// Deterministic discrete-event scheduler over [`VirtualClock`].
///
/// Drives simulation and direct-Rust test cases with bit-for-bit reproducible
/// event interleavings.
#[derive(Debug, Clone, Default)]
pub struct DeterministicScheduler {
	clock: VirtualClock<u64>,
}

impl DeterministicScheduler {
	/// Creates a new scheduler with virtual time starting at 0.
	#[must_use]
	pub fn new() -> Self {
		Self { clock: VirtualClock::new() }
	}

	/// Creates a new scheduler starting at a specified instant.
	#[must_use]
	pub fn with_start(start: VirtualInstant) -> Self {
		Self { clock: VirtualClock::with_start(start) }
	}

	/// The current virtual monotonic instant.
	#[must_use]
	pub const fn now(&self) -> VirtualInstant {
		self.clock.now()
	}

	/// Schedules an event with an explicit deadline and opaque label.
	pub fn schedule(&mut self, deadline: VirtualInstant, label: u64) -> EventId {
		let timer_id = self.clock.register(deadline, label);
		EventId(timer_id.0)
	}

	/// Schedules an event to fire after `delay` relative to the current virtual
	/// instant.
	pub fn schedule_after(&mut self, delay: Duration, label: u64) -> EventId {
		let deadline = self.now().saturating_add(delay);
		self.schedule(deadline, label)
	}

	/// Cancels a scheduled event by id.
	///
	/// Returns `true` if the event was found and canceled, or `false` if it
	/// was not found or had already fired.
	pub fn cancel(&mut self, id: EventId) -> bool {
		self.clock.cancel(TimerId(id.0)).is_some()
	}

	/// The number of pending events in the scheduler queue.
	#[must_use]
	pub fn pending_count(&self) -> usize {
		self.clock.pending_count()
	}

	/// Whether no events are pending.
	#[must_use]
	pub fn is_idle(&self) -> bool {
		self.clock.is_empty()
	}

	/// The deadline of the next scheduled event, if any.
	#[must_use]
	pub fn peek_next_deadline(&self) -> Option<VirtualInstant> {
		self.clock.peek_next_deadline()
	}

	/// Steps the scheduler by executing the single earliest pending event.
	///
	/// Advances virtual time to the event's deadline if the deadline is in
	/// the future.
	pub fn step(&mut self) -> Option<ExecutedEvent> {
		self.clock.step().map(ExecutedEvent::from)
	}

	/// Advances virtual time by `duration` and executes all events due within
	/// the interval in deterministic order.
	pub fn advance_by(&mut self, duration: Duration) -> Vec<ExecutedEvent> {
		self
			.clock
			.advance_by(duration)
			.into_iter()
			.map(ExecutedEvent::from)
			.collect()
	}

	/// Advances virtual time to the earliest scheduled event's deadline and
	/// executes all events due at that instant.
	pub fn advance_to_next_event(&mut self) -> Option<Vec<ExecutedEvent>> {
		self
			.clock
			.advance_to_next_event()
			.map(|timers| timers.into_iter().map(ExecutedEvent::from).collect())
	}

	/// Runs the scheduler until all pending events have executed or `max_steps`
	/// is exceeded.
	///
	/// # Errors
	/// Returns [`StepOverrunError`] if the event queue does not drain within
	/// `max_steps`.
	pub fn run_until_idle(
		&mut self,
		max_steps: usize,
	) -> Result<Vec<ExecutedEvent>, StepOverrunError> {
		let timers = self.clock.run_until_idle(max_steps)?;
		Ok(timers.into_iter().map(ExecutedEvent::from).collect())
	}

	/// Runs the scheduler with a reentrant callback invoked for each executed
	/// event.
	///
	/// Events scheduled within the callback land at their specified deadline
	/// and do not fire in the current step unless their deadline is `<= now()`.
	///
	/// # Errors
	/// Returns [`StepOverrunError`] if execution does not reach idle within
	/// `max_steps`.
	pub fn run_until_idle_with<F>(
		&mut self,
		max_steps: usize,
		mut callback: F,
	) -> Result<usize, StepOverrunError>
	where
		F: FnMut(&mut Self, ExecutedEvent),
	{
		let mut steps = 0;

		while !self.is_idle() {
			if steps >= max_steps {
				return Err(StepOverrunError {
					max_steps,
					steps_executed: steps,
					remaining_events: self.pending_count(),
				});
			}
			let Some(event) = self.step() else {
				break;
			};
			steps += 1;
			callback(self, event);
		}

		Ok(steps)
	}

	/// Reference to the underlying [`VirtualClock`].
	#[must_use]
	pub const fn clock(&self) -> &VirtualClock<u64> {
		&self.clock
	}

	/// Mutable reference to the underlying [`VirtualClock`].
	pub const fn clock_mut(&mut self) -> &mut VirtualClock<u64> {
		&mut self.clock
	}
}
