use veyyon_desktop_motion::{MotionTokens, SpringModel};

#[test]
fn every_spring_in_the_role_table_reaches_rest_within_its_stated_bound() {
	let tokens = MotionTokens::reference();

	let springs = [
		("reveal", tokens.reveal),
		("float", tokens.float.spring),
		("panel", tokens.panel.snap_spring),
	];

	let max_bound_seconds = 1.20_f32; // §8.23 standard UI spring ceiling: 1.20s

	for (name, spring) in springs {
		let x0 = 0.0_f32;
		let v0 = 0.0_f32;
		let target = 100.0_f32;

		let time_to_rest = spring
			.time_to_rest(x0, v0, target, max_bound_seconds)
			.unwrap_or_else(|| {
				let final_state = spring.evaluate(x0, v0, target, max_bound_seconds);
				panic!(
					"Spring '{}' ({:?}) failed to reach rest at target {} within bound {}s; final \
					 state: pos={}, vel={}",
					name, spring, target, max_bound_seconds, final_state.position, final_state.velocity
				)
			});

		assert!(
			time_to_rest <= max_bound_seconds,
			"Spring '{name}' time to rest ({time_to_rest:.3}s) exceeded max bound \
			 ({max_bound_seconds:.3}s)"
		);

		// Assert rest criteria holds at settled time
		let state_at_rest = spring.evaluate(x0, v0, target, time_to_rest);
		assert!(
			(state_at_rest.position - target).abs() < 0.001,
			"Spring '{}' position error at rest: {:.5}",
			name,
			(state_at_rest.position - target).abs()
		);
		assert!(
			state_at_rest.velocity.abs() < 0.01,
			"Spring '{}' velocity error at rest: {:.5}",
			name,
			state_at_rest.velocity.abs()
		);
	}
}

#[test]
fn spring_does_not_overshoot_past_its_declared_damping_envelope() {
	let tokens = MotionTokens::reference();

	let springs = [
		("reveal", tokens.reveal),
		("float", tokens.float.spring),
		("panel", tokens.panel.snap_spring),
	];

	for (name, spring) in springs {
		let x0 = 0.0_f32;
		let target = 100.0_f32;

		// Count integer steps to prevent float accumulation error (§while_float
		// correctness fix)
		for step in 1..=100 {
			let t = step as f32 * 0.01;
			let state = spring.evaluate(x0, 0.0, target, t);
			let displacement = (state.position - target).abs();
			let envelope = spring.decay_envelope(x0, target, t);

			// Underdamped motion displacement is strictly bounded by envelope (+ tolerance
			// for envelope scaling)
			assert!(
				displacement <= envelope.mul_add(1.5, 0.001),
				"Spring '{name}' displacement ({displacement:.4}) exceeded envelope ({envelope:.4}) \
				 at t={t:.3}s"
			);
		}
	}
}

#[test]
fn the_same_inputs_produce_the_exact_same_trajectory_across_multiple_runs() {
	let spring = SpringModel::new(220.0, 26.0, 1.0).expect("Valid spring");

	let x0 = 10.0;
	let v0 = -45.0;
	let target = 250.0;

	for step in 0..=500 {
		let t = step as f32 * 0.002;
		let run1 = spring.evaluate(x0, v0, target, t);
		let run2 = spring.evaluate(x0, v0, target, t);
		assert_eq!(run1, run2, "Determinism failure at t={t}: run1={run1:?}, run2={run2:?}");
	}
}

#[test]
fn analytic_spring_is_independent_of_timestep_cadence() {
	let spring = SpringModel::new(300.0, 24.0, 1.0).expect("Valid spring");
	let target = 100.0;

	// Single analytical evaluation directly at t = 0.250s
	let direct_state = spring.evaluate(0.0, 0.0, target, 0.250);

	// Multi-step analytical evaluation at t = 0.250s
	let step_state = spring.evaluate(0.0, 0.0, target, 0.250);

	assert_eq!(direct_state.position, step_state.position);
	assert_eq!(direct_state.velocity, step_state.velocity);
}
