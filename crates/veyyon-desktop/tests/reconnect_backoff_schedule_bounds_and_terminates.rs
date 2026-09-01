use veyyon_desktop::{
	DeterministicJitter, FATAL_MESSAGE, INITIAL_DELAY_MS, JitterSource, MAX_ATTEMPTS, MAX_DELAY_MS,
	MAX_ELAPSED_MS, ReconnectError, ReconnectPolicy, SeededJitter, ZeroJitter, base_delay_ms,
	delay_with_jitter_factor, max_jitter_delay_ms, min_jitter_delay_ms,
};

#[test]
fn pure_formula_is_monotonically_non_decreasing_and_saturates_at_max_delay() {
	let mut previous_delay = 0;

	for attempt in 1..=MAX_ATTEMPTS {
		let delay = base_delay_ms(attempt);
		assert!(
			delay >= previous_delay,
			"attempt {attempt} delay ({delay}) must be >= previous delay ({previous_delay})"
		);
		assert!(
			delay <= MAX_DELAY_MS,
			"attempt {attempt} delay ({delay}) must not exceed {MAX_DELAY_MS}"
		);
		previous_delay = delay;
	}

	assert_eq!(base_delay_ms(1), INITIAL_DELAY_MS);
	assert_eq!(base_delay_ms(10), MAX_DELAY_MS);
}

#[test]
fn delay_sequence_stays_strictly_within_jitter_bounds() {
	for attempt in 1..=MAX_ATTEMPTS {
		let min_bound = min_jitter_delay_ms(attempt);
		let max_bound = max_jitter_delay_ms(attempt);

		// Test lower bound (-10%)
		let delay_min = delay_with_jitter_factor(attempt, -0.10);
		assert!(
			delay_min >= min_bound,
			"attempt {attempt} min jitter delay {delay_min} must be >= {min_bound}"
		);

		// Test upper bound (+10%)
		let delay_max = delay_with_jitter_factor(attempt, 0.10);
		assert!(
			delay_max <= max_bound,
			"attempt {attempt} max jitter delay {delay_max} must be <= {max_bound}"
		);

		// Test with seeded generator
		let mut seeded = SeededJitter::new(0xabcd_1234_5678_ef01);
		for _ in 0..100 {
			let factor = seeded.jitter_factor();
			assert!((-0.10..=0.10).contains(&factor));
			let d = delay_with_jitter_factor(attempt, factor);
			assert!(d >= min_bound && d <= max_bound);
		}
	}
}

#[test]
fn policy_enforces_maximum_ten_attempts_and_terminates_fatally() {
	let mut policy = ReconnectPolicy::new(ZeroJitter);

	for expected_attempt in 1..=MAX_ATTEMPTS {
		let res = policy.next_delay();
		assert!(res.is_ok(), "attempt {expected_attempt} must succeed, got {res:?}");
		assert_eq!(policy.attempt(), expected_attempt);
	}

	// Attempt 11 must be refused
	let fatal_res = policy.next_delay();
	match fatal_res {
		Err(ReconnectError::Fatal(msg)) => {
			assert_eq!(msg, FATAL_MESSAGE);
		},
		other => panic!("expected ReconnectError::Fatal({FATAL_MESSAGE}), got {other:?}"),
	}
}

#[test]
fn policy_enforces_total_elapsed_window_bound_of_120s() {
	// Inject a deterministic large delay multiplier or simulate max delays
	let mut policy = ReconnectPolicy::new(DeterministicJitter(0.10));

	let mut total_ms = 0;
	for attempt in 1..=MAX_ATTEMPTS {
		match policy.next_delay() {
			Ok(duration) => {
				total_ms += duration.as_millis() as u64;
				assert!(
					total_ms <= MAX_ELAPSED_MS,
					"cumulative elapsed {total_ms} must not exceed {MAX_ELAPSED_MS}"
				);
			},
			Err(ReconnectError::Fatal(msg)) => {
				assert_eq!(msg, FATAL_MESSAGE);
				assert!(attempt <= MAX_ATTEMPTS);
				break;
			},
		}
	}
}
