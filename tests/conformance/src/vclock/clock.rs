//! Virtual clock engine with deterministic timer ordering.
//!
//! [`VirtualClock`] manages virtual monotonic time and a priority queue of
//! registered timers. Timers due at the exact same instant fire in monotonic
//! registration order (FIFO), deterministically, on every platform.

use std::{
	cmp,
	collections::{BTreeMap, HashMap},
	fmt,
	time::Duration,
};

use serde::{Deserialize, Serialize};

use super::VirtualInstant;

/// An opaque identifier for a registered timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TimerId(pub u64);

impl fmt::Display for TimerId {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "timer#{}", self.0)
	}
}

/// A timer that has been fired by the virtual clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FiredTimer<T> {
	/// The unique identifier assigned at registration.
	pub id:               TimerId,
	/// The deadline this timer was scheduled for.
	pub deadline:         VirtualInstant,
	/// The instant at which the clock fired this timer.
	pub fired_at:         VirtualInstant,
	/// The monotonic registration sequence number.
	pub registration_seq: u64,
	/// The caller-supplied payload.
	pub payload:          T,
}

/// Error returned when [`VirtualClock::run_until_idle`] or a scheduler run
/// exceeds the caller-supplied step bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepOverrunError {
	/// The maximum allowed execution steps.
	pub max_steps:        usize,
	/// The number of steps executed before the limit was reached.
	pub steps_executed:   usize,
	/// The count of pending events/timers still queued.
	pub remaining_events: usize,
}

impl fmt::Display for StepOverrunError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"scheduler exceeded maximum step bound of {} (executed {} steps, {} events remaining)",
			self.max_steps, self.steps_executed, self.remaining_events
		)
	}
}

impl std::error::Error for StepOverrunError {}

/// Internal storage entry for a registered timer.
#[derive(Debug, Clone)]
struct TimerEntry<T> {
	id:       TimerId,
	deadline: VirtualInstant,
	payload:  T,
}

/// Deterministic virtual monotonic clock.
///
/// Timers are ordered by the composite key `(deadline, registration_seq)`.
/// Two timers scheduled for the exact same [`VirtualInstant`] fire strictly in
/// the order they were registered.
#[derive(Debug, Clone)]
pub struct VirtualClock<T = u64> {
	now:       VirtualInstant,
	next_seq:  u64,
	timers:    BTreeMap<(VirtualInstant, u64), TimerEntry<T>>,
	id_to_key: HashMap<TimerId, (VirtualInstant, u64)>,
}

impl<T> Default for VirtualClock<T> {
	fn default() -> Self {
		Self::new()
	}
}

impl<T> VirtualClock<T> {
	/// Creates a new virtual clock starting at [`VirtualInstant::ZERO`].
	#[must_use]
	pub fn new() -> Self {
		Self {
			now:       VirtualInstant::ZERO,
			next_seq:  0,
			timers:    BTreeMap::new(),
			id_to_key: HashMap::new(),
		}
	}

	/// Creates a new virtual clock starting at a specified instant.
	#[must_use]
	pub fn with_start(start: VirtualInstant) -> Self {
		Self { now: start, next_seq: 0, timers: BTreeMap::new(), id_to_key: HashMap::new() }
	}

	/// The current virtual monotonic instant.
	#[must_use]
	pub const fn now(&self) -> VirtualInstant {
		self.now
	}

	/// Number of pending timers currently registered.
	#[must_use]
	pub fn pending_count(&self) -> usize {
		self.timers.len()
	}

	/// Whether no timers are currently registered.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.timers.is_empty()
	}

	/// The deadline of the earliest scheduled timer, if any.
	#[must_use]
	pub fn peek_next_deadline(&self) -> Option<VirtualInstant> {
		self.timers.first_key_value().map(|(key, _)| key.0)
	}

	/// Registers a timer with a deadline and payload.
	///
	/// Returns a unique [`TimerId`] that can be used to cancel the timer before
	/// it fires. Timers with identical deadlines are ordered by registration
	/// sequence.
	pub fn register(&mut self, deadline: VirtualInstant, payload: T) -> TimerId {
		let seq = self.next_seq;
		self.next_seq = self.next_seq.saturating_add(1);
		let id = TimerId(seq);
		let key = (deadline, seq);
		let entry = TimerEntry { id, deadline, payload };
		self.timers.insert(key, entry);
		self.id_to_key.insert(id, key);
		id
	}

	/// Cancels a registered timer by id.
	///
	/// Returns `Some(payload)` if the timer was pending and removed, or `None`
	/// if the timer was not found or had already fired. Cancellation removes
	/// exactly the target timer and leaves all other timers undisturbed.
	pub fn cancel(&mut self, id: TimerId) -> Option<T> {
		let key = self.id_to_key.remove(&id)?;
		let entry = self.timers.remove(&key)?;
		Some(entry.payload)
	}

	/// Advances virtual time by `duration` and fires all timers due up to and
	/// including the new instant.
	///
	/// Timers are returned in deterministic firing order: `(deadline,
	/// registration_seq)`.
	pub fn advance_by(&mut self, duration: Duration) -> Vec<FiredTimer<T>> {
		self.now = self.now.saturating_add(duration);
		self.drain_due_timers()
	}

	/// Advances virtual time to the deadline of the earliest pending timer and
	/// fires all timers due at that instant.
	///
	/// If no timers are registered, returns `None` and leaves `now` unchanged.
	/// If the earliest deadline is in the past relative to `now`, `now` is not
	/// decremented (monotonicity is preserved) and all due timers are fired.
	pub fn advance_to_next_event(&mut self) -> Option<Vec<FiredTimer<T>>> {
		let earliest_deadline = self.peek_next_deadline()?;
		self.now = cmp::max(self.now, earliest_deadline);
		Some(self.drain_due_timers())
	}

	/// Steps the clock by popping and firing the single earliest pending timer,
	/// advancing `now` to its deadline if the deadline is in the future.
	///
	/// Returns `None` if no timers are pending.
	pub fn step(&mut self) -> Option<FiredTimer<T>> {
		let ((deadline, seq), entry) = self.timers.pop_first()?;
		self.id_to_key.remove(&entry.id);
		self.now = cmp::max(self.now, deadline);
		Some(FiredTimer {
			id:               entry.id,
			deadline:         entry.deadline,
			fired_at:         self.now,
			registration_seq: seq,
			payload:          entry.payload,
		})
	}

	/// Runs the clock until all pending timers have fired, bounded by
	/// `max_steps`.
	///
	/// Each step fires one timer. If the number of steps reaches `max_steps`
	/// while timers remain, execution halts and returns
	/// [`StepOverrunError`] to catch infinite loops and non-terminating
	/// cascades.
	///
	/// # Errors
	/// Returns [`StepOverrunError`] if the clock does not run to idle within
	/// `max_steps`.
	pub fn run_until_idle(
		&mut self,
		max_steps: usize,
	) -> Result<Vec<FiredTimer<T>>, StepOverrunError> {
		let mut fired = Vec::new();
		let mut steps = 0;

		while !self.is_empty() {
			if steps >= max_steps {
				return Err(StepOverrunError {
					max_steps,
					steps_executed: steps,
					remaining_events: self.pending_count(),
				});
			}
			if let Some(timer) = self.step() {
				fired.push(timer);
				steps += 1;
			}
		}

		Ok(fired)
	}

	/// Executes steps with a callback that receives a mutable reference to the
	/// clock and the fired timer.
	///
	/// This supports reentrant timer registration during firing: timers
	/// registered during callback execution land at their scheduled deadline
	/// and do NOT fire in the current step unless already due.
	///
	/// # Errors
	/// Returns [`StepOverrunError`] if execution does not become idle within
	/// `max_steps`.
	pub fn run_until_idle_with<F>(
		&mut self,
		max_steps: usize,
		mut callback: F,
	) -> Result<usize, StepOverrunError>
	where
		F: FnMut(&mut Self, FiredTimer<T>),
	{
		let mut steps = 0;

		while !self.is_empty() {
			if steps >= max_steps {
				return Err(StepOverrunError {
					max_steps,
					steps_executed: steps,
					remaining_events: self.pending_count(),
				});
			}
			let Some(timer) = self.step() else {
				break;
			};
			steps += 1;
			callback(self, timer);
		}

		Ok(steps)
	}

	/// Internal helper to pop all timers with `deadline <= self.now`.
	fn drain_due_timers(&mut self) -> Vec<FiredTimer<T>> {
		let mut fired = Vec::new();
		while let Some((&(deadline, _), _)) = self.timers.first_key_value() {
			if deadline > self.now {
				break;
			}
			let ((_, seq), entry) = self.timers.pop_first().expect("entry present from peek");
			self.id_to_key.remove(&entry.id);
			fired.push(FiredTimer {
				id:               entry.id,
				deadline:         entry.deadline,
				fired_at:         self.now,
				registration_seq: seq,
				payload:          entry.payload,
			});
		}
		fired
	}
}
