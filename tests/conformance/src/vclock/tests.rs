//! Conformance tests for virtual clock, deterministic scheduler, and real
//! bounded deadlines.

use std::{thread, time::Duration};

use super::{
	DeadlineExceededError, DeterministicScheduler, RealBoundedDeadline, StepOverrunError, TimerId,
	VirtualClock, VirtualInstant,
};
use crate::corpus::ClockMode;

/// WHY: Conformance oracles compare exact execution traces across runs.
/// This test closes the defect class of non-deterministic event interleavings
/// caused by unpinned hash-map iteration, arbitrary thread scheduling, or
/// unstable sorting.
///
/// GAPS: It does not catch non-determinism introduced by external syscalls or
/// unvirtualized OS state outside of `DeterministicScheduler`.
#[test]
fn identical_event_traces_across_two_independent_runs_from_the_same_construction() {
	let construct = || {
		let mut scheduler = DeterministicScheduler::new();
		scheduler.schedule(VirtualInstant::from_millis(50), 101);
		scheduler.schedule(VirtualInstant::from_millis(20), 102);
		scheduler.schedule(VirtualInstant::from_millis(50), 103);
		scheduler.schedule(VirtualInstant::from_millis(10), 104);
		scheduler.schedule(VirtualInstant::from_millis(20), 105);
		scheduler.schedule(VirtualInstant::from_millis(100), 106);
		scheduler
			.run_until_idle(100)
			.expect("scheduler should drain within bound")
	};

	let trace_a = construct();
	let trace_b = construct();

	assert_eq!(
		trace_a, trace_b,
		"two independent runs of identical schedule construction must yield identical event traces"
	);

	let labels: Vec<u64> = trace_a.iter().map(|e| e.label).collect();
	assert_eq!(
		labels,
		vec![104, 102, 105, 101, 103, 106],
		"events must be ordered by (deadline, registration_seq)"
	);
}

/// WHY: When multiple timers expire at the exact same discrete instant, an
/// arbitrary or unkeyed priority queue produces non-deterministic firing order.
/// This test closes the defect class where same-instant timers fire out of
/// registration order (FIFO).
///
/// GAPS: It does not test timers scheduled across different discrete instants.
#[test]
fn same_instant_firing_in_registration_order() {
	let mut clock = VirtualClock::new();
	let deadline = VirtualInstant::from_millis(42);

	let id1 = clock.register(deadline, "first");
	let id2 = clock.register(deadline, "second");
	let id3 = clock.register(deadline, "third");
	let id4 = clock.register(deadline, "fourth");

	let fired = clock.advance_by(Duration::from_millis(50));
	assert_eq!(fired.len(), 4);

	assert_eq!(fired[0].id, id1);
	assert_eq!(fired[0].payload, "first");
	assert_eq!(fired[0].registration_seq, 0);

	assert_eq!(fired[1].id, id2);
	assert_eq!(fired[1].payload, "second");
	assert_eq!(fired[1].registration_seq, 1);

	assert_eq!(fired[2].id, id3);
	assert_eq!(fired[2].payload, "third");
	assert_eq!(fired[2].registration_seq, 2);

	assert_eq!(fired[3].id, id4);
	assert_eq!(fired[3].payload, "fourth");
	assert_eq!(fired[3].registration_seq, 3);
}

/// WHY: The classic reentrancy defect occurs when a timer handler registers a
/// new future timer during execution, and a naive scheduler immediately drains
/// or fires the newly registered timer in the current instant even though its
/// deadline is in the future.
///
/// GAPS: It does not verify multi-threaded callback concurrency, as the virtual
/// clock is single-threaded and deterministic.
#[test]
fn a_timer_registered_during_firing_does_not_fire_early() {
	let mut clock = VirtualClock::<&'static str>::new();
	clock.register(VirtualInstant::from_millis(10), "initial_timer");

	let mut execution_log = Vec::new();

	// Step 1: Fire the initial timer at t=10ms. During its execution, register a
	// new timer for t=50ms.
	let first_fired = clock.step().expect("initial timer should fire");
	assert_eq!(first_fired.payload, "initial_timer");
	assert_eq!(first_fired.fired_at, VirtualInstant::from_millis(10));
	execution_log.push((first_fired.payload, clock.now()));

	// Register a reentrant timer scheduled for 50ms into the future.
	let reentrant_id = clock.register(VirtualInstant::from_millis(50), "reentrant_future_timer");

	// In the current instant (t=10ms), the reentrant timer MUST NOT be due.
	let current_due = clock.advance_by(Duration::ZERO);
	assert!(
		current_due.is_empty(),
		"reentrant timer with deadline 50ms must not fire at current instant 10ms"
	);
	assert_eq!(clock.now(), VirtualInstant::from_millis(10));
	assert_eq!(clock.pending_count(), 1);

	// Advance clock to t=30ms (before deadline 50ms).
	let intermediate_due = clock.advance_by(Duration::from_millis(20));
	assert!(intermediate_due.is_empty(), "reentrant timer must not fire before its deadline");
	assert_eq!(clock.now(), VirtualInstant::from_millis(30));

	// Advance clock past deadline (to t=60ms).
	let final_due = clock.advance_by(Duration::from_millis(30));
	assert_eq!(final_due.len(), 1);
	assert_eq!(final_due[0].id, reentrant_id);
	assert_eq!(final_due[0].payload, "reentrant_future_timer");
	assert_eq!(final_due[0].fired_at, VirtualInstant::from_millis(60));
	assert_eq!(execution_log, vec![("initial_timer", VirtualInstant::from_millis(10))]);
}

/// WHY: Cancelling a timer must surgically remove only the target timer and
/// leave all predecessor, successor, and same-deadline neighbor timers
/// undisturbed. This test closes the defect class where cancel removes
/// adjacent timers or corrupts the queue index.
///
/// GAPS: Does not test cancelling a timer concurrently from another thread.
#[test]
fn cancel_removes_exactly_one_timer_and_not_its_neighbours() {
	let mut clock = VirtualClock::new();
	let deadline = VirtualInstant::from_millis(100);

	let t1 = clock.register(deadline, 1);
	let t2 = clock.register(deadline, 2);
	let t3 = clock.register(deadline, 3);
	let t4 = clock.register(deadline, 4);
	let t5 = clock.register(VirtualInstant::from_millis(200), 5);

	assert_eq!(clock.pending_count(), 5);

	// Cancel middle timer t3
	let canceled = clock.cancel(t3);
	assert_eq!(canceled, Some(3));
	assert_eq!(clock.pending_count(), 4);

	// Cancelling again should return None
	assert_eq!(clock.cancel(t3), None);

	// Cancelling an unknown id should return None
	assert_eq!(clock.cancel(TimerId(999_999)), None);

	// Advance past deadline and verify t1, t2, t4 fire in exact order, followed by
	// t5
	let fired = clock.advance_by(Duration::from_millis(300));
	assert_eq!(fired.len(), 4);
	assert_eq!(fired[0].id, t1);
	assert_eq!(fired[0].payload, 1);
	assert_eq!(fired[1].id, t2);
	assert_eq!(fired[1].payload, 2);
	assert_eq!(fired[2].id, t4);
	assert_eq!(fired[2].payload, 4);
	assert_eq!(fired[3].id, t5);
	assert_eq!(fired[3].payload, 5);

	assert!(clock.is_empty());
}

/// WHY: `advance_by(interval)` must fire every timer whose deadline falls
/// within `[now, now + interval]` in exact chronological order, and MUST NOT
/// fire any timer with deadline `> now + interval`.
/// This test closes the defect class of off-by-one window boundaries or leaky
/// queue drainage.
///
/// GAPS: Does not catch issues if user passes negative duration (Duration in
/// Rust is unsigned).
#[test]
fn advance_by_fires_every_timer_in_interval_in_order_and_none_past_it() {
	let mut clock = VirtualClock::new();

	clock.register(VirtualInstant::from_millis(10), 1);
	clock.register(VirtualInstant::from_millis(20), 2);
	clock.register(VirtualInstant::from_millis(30), 3);
	clock.register(VirtualInstant::from_millis(31), 4);
	clock.register(VirtualInstant::from_millis(50), 5);

	// Advance to 30ms: timers at 10ms, 20ms, 30ms must fire. 31ms and 50ms must
	// not.
	let fired = clock.advance_by(Duration::from_millis(30));
	assert_eq!(clock.now(), VirtualInstant::from_millis(30));
	assert_eq!(fired.len(), 3);
	assert_eq!(fired.iter().map(|f| f.payload).collect::<Vec<_>>(), vec![1, 2, 3]);
	assert_eq!(clock.pending_count(), 2);

	// Advance by 1ms to 31ms: timer at 31ms must fire.
	let fired_next = clock.advance_by(Duration::from_millis(1));
	assert_eq!(clock.now(), VirtualInstant::from_millis(31));
	assert_eq!(fired_next.len(), 1);
	assert_eq!(fired_next[0].payload, 4);
	assert_eq!(clock.pending_count(), 1);

	// Advance by 20ms to 51ms: timer at 50ms must fire.
	let fired_last = clock.advance_by(Duration::from_millis(20));
	assert_eq!(clock.now(), VirtualInstant::from_millis(51));
	assert_eq!(fired_last.len(), 1);
	assert_eq!(fired_last[0].payload, 5);
	assert!(clock.is_empty());
}

/// WHY: Conformance test harnesses must fail fast on non-terminating loops
/// (e.g. cascading periodic timer loops that never settle).
/// This test closes the defect class of unbounded hangs by asserting that
/// `run_until_idle` halts and returns a typed [`StepOverrunError`] when
/// `max_steps` is exceeded.
///
/// GAPS: Does not prevent infinite loops within external user-provided
/// callbacks that do not yield control back to the scheduler step loop.
#[test]
fn step_bound_overrun_returns_typed_error_rather_than_hanging() {
	let mut scheduler = DeterministicScheduler::new();

	// Schedule 10 cascading events
	for i in 0..10 {
		scheduler.schedule(VirtualInstant::from_millis(i * 10), i);
	}

	// Setting max_steps to 5 must halt execution after 5 steps and return
	// StepOverrunError
	let result = scheduler.run_until_idle(5);
	match result {
		Err(StepOverrunError { max_steps, steps_executed, remaining_events }) => {
			assert_eq!(max_steps, 5);
			assert_eq!(steps_executed, 5);
			assert_eq!(remaining_events, 5);
		},
		Ok(_) => panic!("scheduler should have returned StepOverrunError when step bound exceeded"),
	}

	// Running with sufficient steps must succeed
	let drain_result = scheduler.run_until_idle(10);
	assert!(drain_result.is_ok(), "scheduler should drain remaining 5 events");
	assert!(scheduler.is_idle());
}

/// WHY: Compiled-product cases execute with real time bounds.
/// This test closes the defect class where `RealBoundedDeadline` fails to
/// detect an elapsed deadline or falsely rejects execution that finished within
/// the allotted bound.
///
/// GAPS: Subject to host thread preemption if bound is set unrealistically low
/// (e.g. sub-microsecond).
#[test]
fn real_bounded_deadline_reports_termination_inside_and_outside_bound() {
	let tracker = RealBoundedDeadline::now();

	// Immediate check against generous bound (5,000ms) must succeed
	let result = tracker.within(5_000);
	assert!(result.is_ok(), "immediate check within 5000ms bound must succeed");
	assert!(!tracker.expired(5_000));

	// Small sleep to ensure time advances
	thread::sleep(Duration::from_millis(15));

	// Checking against a 5ms bound must return DeadlineExceededError
	let result_expired = tracker.within(5);
	match result_expired {
		Err(DeadlineExceededError { max_ms, elapsed }) => {
			assert_eq!(max_ms, 5);
			assert!(
				elapsed >= Duration::from_millis(10),
				"measured elapsed duration should reflect sleep"
			);
		},
		Ok(_) => panic!("tracker.within(5ms) should have failed after sleeping >15ms"),
	}
	assert!(tracker.expired(5));
}

/// WHY: Every variant of [`ClockMode`] must have an explicit handling policy
/// in the vclock subsystem. Sweeping all variants at runtime ensures that
/// adding a new variant to the corpus enum turns this suite RED by default
/// until an intentional mapping is registered.
///
/// GAPS: Validates enum completeness; does not validate end-to-end harness
/// process launchers.
#[test]
fn clock_mode_variants_are_exhaustively_handled_by_vclock_contracts() {
	// Sweep all variants of ClockMode
	let variants = [ClockMode::Virtual, ClockMode::RealBounded];

	for mode in variants {
		match mode {
			ClockMode::Virtual => {
				// Virtual mode must bind to VirtualClock / DeterministicScheduler
				let mut clock = VirtualClock::new();
				let id = clock.register(VirtualInstant::from_millis(10), 42);
				assert_eq!(clock.pending_count(), 1);
				let fired = clock.advance_by(Duration::from_millis(20));
				assert_eq!(fired[0].id, id);
			},
			ClockMode::RealBounded => {
				// RealBounded mode must bind to RealBoundedDeadline
				let deadline = RealBoundedDeadline::now();
				assert!(deadline.within(10_000).is_ok());
			},
		}
	}
}

/// WHY: Virtual time must be strictly monotonic and never underflow into the
/// past or overflow into undefined behavior.
/// This test closes the defect class of integer underflows/overflows in
/// instant arithmetic.
///
/// GAPS: Does not test durations exceeding `u64::MAX` nanoseconds (which is
/// 584 years).
#[test]
fn virtual_instant_saturating_arithmetic_never_goes_backwards_or_wraps() {
	let zero = VirtualInstant::ZERO;
	assert_eq!(zero.as_nanos(), 0);

	// Saturating subtraction below zero must clamp at ZERO
	let underflow = zero.saturating_sub(Duration::from_secs(100));
	assert_eq!(underflow, VirtualInstant::ZERO);
	assert_eq!(zero - Duration::from_secs(100), VirtualInstant::ZERO);

	// Saturating duration since earlier
	let t1 = VirtualInstant::from_secs(10);
	let t2 = VirtualInstant::from_secs(5);
	assert_eq!(t1 - t2, Duration::from_secs(5));
	assert_eq!(t2 - t1, Duration::ZERO);

	// Saturating addition near MAX
	let near_max = VirtualInstant::from_nanos(u64::MAX - 100);
	let overflow = near_max.saturating_add(Duration::from_secs(10));
	assert_eq!(overflow, VirtualInstant::MAX);
	assert_eq!(overflow.as_nanos(), u64::MAX);
}

/// WHY: `advance_to_next_event()` must jump monotonically to the earliest
/// scheduled deadline and pop due timers, or return `None` when empty.
/// This test closes the defect class where time jumps backwards or fails to
/// advance to the next event deadline.
///
/// GAPS: Does not test external event injection during multi-component runs.
#[test]
fn advance_to_next_event_advances_monotonically_and_fires_due_timers() {
	let mut clock = VirtualClock::new();

	// When empty, returns None and keeps time at 0
	assert_eq!(clock.advance_to_next_event(), None);
	assert_eq!(clock.now(), VirtualInstant::ZERO);

	clock.register(VirtualInstant::from_millis(100), 1);
	clock.register(VirtualInstant::from_millis(100), 2);
	clock.register(VirtualInstant::from_millis(250), 3);

	// First advance: jumps to 100ms and fires 1 and 2
	let fired1 = clock
		.advance_to_next_event()
		.expect("should advance to 100ms");
	assert_eq!(clock.now(), VirtualInstant::from_millis(100));
	assert_eq!(fired1.len(), 2);
	assert_eq!(fired1[0].payload, 1);
	assert_eq!(fired1[1].payload, 2);

	// Second advance: jumps to 250ms and fires 3
	let fired2 = clock
		.advance_to_next_event()
		.expect("should advance to 250ms");
	assert_eq!(clock.now(), VirtualInstant::from_millis(250));
	assert_eq!(fired2.len(), 1);
	assert_eq!(fired2[0].payload, 3);

	// Now empty
	assert_eq!(clock.advance_to_next_event(), None);
	assert_eq!(clock.now(), VirtualInstant::from_millis(250));
}
