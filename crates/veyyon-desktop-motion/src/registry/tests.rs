use std::time::Duration;

use super::*;
use crate::{ALL_ROLES, MotionTokens, spring::SpringModel};

#[test]
fn test_relayout_preserves_progress() {
	let mut registry = AnimatorRegistry::new();
	let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, 42);
	let spring = SpringModel::new(220.0, 26.0, 1.0).unwrap();
	let model = MotionModel::Spring(spring);
	let t0 = Instant::now();
	registry.get_or_create(key, 100.0, model, t0);
	let t1 = t0 + Duration::from_millis(50);
	let anim = registry.get_or_create(key, 100.0, model, t1);
	assert!(anim.current_value > 5.0 && anim.current_value < 90.0);
	assert!(anim.current_velocity > 0.0);
}

#[test]
fn test_remount_preserves_progress() {
	let mut registry = AnimatorRegistry::new();
	let key = AnimatorKey::new(SurfaceId::Composer, MotionRole::Float, 101);
	let spring = SpringModel::new(300.0, 24.0, 1.0).unwrap();
	let model = MotionModel::Spring(spring);
	let t0 = Instant::now();
	registry.get_or_create(key, 100.0, model, t0);
	let t1 = t0 + Duration::from_millis(80);
	let val1 = registry.get_or_create(key, 100.0, model, t1).current_value;
	let val2 = registry.get_or_create(key, 100.0, model, t1).current_value;
	assert_eq!(val1, val2);
	assert!(val2 > 20.0);
}

#[test]
fn test_interruption_retains_velocity_and_position() {
	let mut registry = AnimatorRegistry::new();
	let key = AnimatorKey::new(SurfaceId::RightPanel, MotionRole::Panel, 1);
	let spring = SpringModel::new(180.0, 22.0, 1.0).unwrap();
	let model = MotionModel::Spring(spring);
	let t0 = Instant::now();
	registry.get_or_create(key, 100.0, model, t0);
	let t_int = t0 + Duration::from_millis(40);
	let (pos, vel, _) = registry.animations.get(&key).unwrap().sample_at(t_int);
	assert!(pos > 10.0 && pos < 70.0);
	assert!(vel > 10.0);
	registry.update_target(key, 0.0, model, t_int);
	let anim = registry.animations.get(&key).unwrap();
	assert_eq!(anim.start_value, pos);
	assert_eq!(anim.start_velocity, vel);
	assert_eq!(anim.current_velocity, vel);
	assert_eq!(anim.target_value, 0.0);
	let t_after = t_int + Duration::from_millis(1);
	let (pos_after, ..) = anim.sample_at(t_after);
	assert!((pos_after - pos).abs() < 5.0);
}

/// Sampling a settled animation must persist rest, not keep scheduling frames.
/// Sweeps every registered role; only the periodic caret remains active.
#[test]
fn sampled_roles_persist_their_settlement() {
	let tokens = MotionTokens::reference();
	let now = Instant::now();
	let mut periodic = Vec::new();
	for role in ALL_ROLES {
		let mut registry = AnimatorRegistry::new();
		let key = AnimatorKey::new(SurfaceId::Shell, role, 0);
		registry.get_or_create_with_initial(key, 0.0, 1.0, tokens.get_model(role), now);
		let (position, velocity, settled) = registry
			.sample_full(&key, now + Duration::from_secs(2))
			.unwrap();
		assert_eq!(registry.is_at_rest(&key), settled, "{role:?}");
		if settled {
			assert_eq!((position, velocity), (1.0, 0.0), "{role:?}");
			assert_eq!(
				registry.sample_full(&key, now + Duration::from_secs(3)),
				Some((1.0, 0.0, true))
			);
		} else {
			periodic.push(role);
		}
	}
	assert_eq!(periodic, vec![MotionRole::Caret]);
}
