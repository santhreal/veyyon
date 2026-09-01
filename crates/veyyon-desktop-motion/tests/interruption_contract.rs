use std::time::{Duration, Instant};

use veyyon_desktop_motion::{
	AnimatorKey, AnimatorRegistry, MotionModel, MotionRole, SpringModel, SurfaceId,
};

#[test]
fn an_animation_interrupted_at_40_percent_reverses_from_40_percent_with_non_zero_velocity() {
	let spring = SpringModel::new(220.0, 26.0, 1.0).expect("Valid spring");
	let start_pos = 0.0_f32;
	let target_pos = 100.0_f32;

	// 1. Find the time t_40 where displacement reaches 40% (40.0 px)
	let mut t_40 = 0.0_f32;
	let dt = 0.0005_f32;
	let mut state_at_40 = spring.evaluate(start_pos, 0.0, target_pos, 0.0);

	// Count integer steps to prevent float accumulation error (§while_float
	// correctness fix)
	let step_count = (0.5_f32 / dt).ceil() as usize;
	for step in 0..=step_count {
		let t = step as f32 * dt;
		let state = spring.evaluate(start_pos, 0.0, target_pos, t);
		if state.position >= 40.0 {
			t_40 = t;
			state_at_40 = state;
			break;
		}
	}

	// Assert the 40% state has non-zero velocity on the integrator
	assert!(
		(state_at_40.position - 40.0).abs() < 1.0,
		"Expected position ~40.0, got {:.3}",
		state_at_40.position
	);
	assert!(
		state_at_40.velocity > 100.0,
		"Integrator velocity at 40% must be non-zero and positive, got {:.3}",
		state_at_40.velocity
	);

	// 2. Interrupt and reverse direction towards 0.0 from 40% using the registry
	let mut registry = AnimatorRegistry::new();
	let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, 1);
	let model = MotionModel::Spring(spring);

	let t0 = Instant::now();
	registry.get_or_create(key, target_pos, model, t0);

	// Advance clock by t_40 to trigger interruption at exactly 40%
	let t_interrupt = t0 + Duration::from_secs_f32(t_40);
	registry.update_target(key, 0.0, model, t_interrupt);

	// 3. Directly inspect the integrator state in the registry
	let interrupted_anim = registry
		.remove(&key)
		.expect("Animation must exist in registry");

	assert_eq!(interrupted_anim.target_value, 0.0, "Target must be reversed to 0.0");

	// Verify starting position for reversal is 40%, NOT reset to 0.0
	assert!(
		(interrupted_anim.start_value - 40.0).abs() < 1.0,
		"Reversal must start from 40% ({:.3}), not from 0.0",
		interrupted_anim.start_value
	);

	// Verify initial velocity for reversal is non-zero (carrying forward momentum)
	assert!(
		interrupted_anim.current_velocity > 100.0,
		"Reversal must carry non-zero velocity forward ({:.3})",
		interrupted_anim.current_velocity
	);

	// 4. Verify evaluation immediately after interruption (0.1ms into reversal)
	let sample_time = t_interrupt + Duration::from_micros(100);
	let (pos_after, vel_after, _) = interrupted_anim.sample_at(sample_time);

	assert!(
		(pos_after - interrupted_anim.start_value).abs() < 0.1,
		"Position must be continuous across interruption: before={}, after={}",
		interrupted_anim.start_value,
		pos_after
	);
	assert!(
		(vel_after - interrupted_anim.current_velocity).abs() < 5.0,
		"Velocity must be continuous across interruption: before={}, after={}",
		interrupted_anim.current_velocity,
		vel_after
	);
}
