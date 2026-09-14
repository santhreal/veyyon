use std::time::{Duration, Instant};

use veyyon_desktop_motion::{
	AnimatorKey, AnimatorRegistry, MotionModel, MotionRole, SpringModel, SurfaceId,
};

#[test]
fn a_re_layout_preserves_animation_progress() {
	let mut registry = AnimatorRegistry::new();
	let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, 42);
	let spring = SpringModel::new(220.0, 26.0, 1.0).expect("Valid spring");
	let model = MotionModel::Spring(spring);

	let t0 = Instant::now();

	// Step 1: Initial layout passes start the animation expanding from 0 to 100
	let initial_anim = registry.get_or_create(key, 100.0, model, t0);
	assert_eq!(initial_anim.current_value, 0.0);
	assert_eq!(initial_anim.target_value, 100.0);

	// Step 2: 60ms passes and a layout recomputation occurs
	let t_relayout = t0 + Duration::from_millis(60);
	let relayout_anim = registry.get_or_create(key, 100.0, model, t_relayout);

	// Assert that progress has been made and preserved during re-layout pass
	assert!(
		relayout_anim.current_value > 20.0 && relayout_anim.current_value < 85.0,
		"Progress must not be reset on re-layout: got {:.3}",
		relayout_anim.current_value
	);
	assert!(
		relayout_anim.current_velocity > 50.0,
		"Velocity must not be zeroed on re-layout: got {:.3}",
		relayout_anim.current_velocity
	);
	assert_eq!(
		relayout_anim.start_time, t0,
		"Original animation start_time must be preserved across re-layout"
	);
}

#[test]
fn a_remount_preserves_animation_progress_across_component_destruction() {
	let mut registry = AnimatorRegistry::new();
	let key = AnimatorKey::new(SurfaceId::Composer, MotionRole::Float, 999);
	let spring = SpringModel::new(300.0, 24.0, 1.0).expect("Valid spring");
	let model = MotionModel::Spring(spring);

	let t0 = Instant::now();

	// Step 1: Component mounts and registers animation
	registry.get_or_create(key, 100.0, model, t0);

	// Step 2: Component is active for 75ms
	let t_unmount = t0 + Duration::from_millis(75);
	let val_before_unmount = registry
		.get_or_create(key, 100.0, model, t_unmount)
		.current_value;

	assert!(
		val_before_unmount > 30.0,
		"Animation must have advanced before unmount: got {val_before_unmount:.3}"
	);

	// Step 3: Component is destroyed / unmounted, and remounts 10ms later (t =
	// 85ms) The new component instance queries the registry with the identical
	// stable AnimatorKey
	let t_remount = t0 + Duration::from_millis(85);
	let remounted_anim = registry.get_or_create(key, 100.0, model, t_remount);

	// Assert that the remounted component continues from current progress without
	// flashing or restarting from 0
	assert!(
		remounted_anim.current_value >= val_before_unmount,
		"Remount must continue from existing progress (before={val_before_unmount}, after={})",
		remounted_anim.current_value
	);
	assert!(
		remounted_anim.current_value < 100.0,
		"Remounted animation should still be in flight: got {:.3}",
		remounted_anim.current_value
	);
	assert_eq!(
		remounted_anim.start_time, t0,
		"Remount must not reset start_time to current instant"
	);
}
