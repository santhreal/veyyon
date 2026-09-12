//! Motion driver for tint transitions: hover, selection, focus, badge color,
//! scrim (`MotionRole::Tint`).

use std::time::Instant;

use crate::{
	curves::EasingCurve,
	registry::{AnimatorKey, AnimatorRegistry, SurfaceId},
	role::{DurationModel, MotionModel, MotionRole, ResolvedMotion, resolve_motion},
	tokens::MotionTokens,
};

/// Motion driver for tint transitions: hover, selection, focus, badge color,
/// scrim (`MotionRole::Tint`).
#[derive(Debug)]
pub struct TintMotion {
	surface_id:    SurfaceId,
	slot:          u64,
	registry:      AnimatorRegistry,
	current_value: f32,
}

impl TintMotion {
	/// Creates a new tint motion driver.
	#[must_use]
	pub fn new(surface_id: SurfaceId, slot: u64, initial_value: f32) -> Self {
		let mut registry = AnimatorRegistry::new();
		let key = AnimatorKey::new(surface_id, MotionRole::Tint, slot);
		let model = MotionModel::Duration(DurationModel {
			duration_ms: 120,
			curve:       EasingCurve::EaseOut,
		});
		registry.get_or_create_with_initial(key, initial_value, initial_value, model, Instant::now());
		Self { surface_id, slot, registry, current_value: initial_value }
	}

	/// Sets new tint target value (e.g. 0.0 to 1.0).
	pub fn set_target(&mut self, target: f32, tokens: &MotionTokens, reduced: bool, now: Instant) {
		let key = AnimatorKey::new(self.surface_id, MotionRole::Tint, self.slot);
		if let ResolvedMotion::Duration { duration_ms, curve } =
			resolve_motion(MotionRole::Tint, tokens, reduced)
		{
			let model = MotionModel::Duration(DurationModel { duration_ms, curve });
			self.registry.update_target(key, target, model, now);
		} else {
			let model = MotionModel::Duration(DurationModel {
				duration_ms: 0,
				curve:       EasingCurve::Linear,
			});
			let anim = self
				.registry
				.get_or_create_with_initial(key, target, target, model, now);
			anim.start_value = target;
			anim.current_value = target;
			anim.target_value = target;
			anim.is_at_rest = true;
			self.current_value = target;
		}
	}

	/// Samples current tint value and settled state.
	pub fn sample(&mut self, now: Instant) -> (f32, bool) {
		let key = AnimatorKey::new(self.surface_id, MotionRole::Tint, self.slot);
		if let Some((pos, _, at_rest)) = self.registry.sample_full(&key, now) {
			self.current_value = pos;
			(pos, at_rest)
		} else {
			(self.current_value, true)
		}
	}

	/// Returns the current tint value.
	#[must_use]
	pub const fn current_value(&self) -> f32 {
		self.current_value
	}

	/// Returns true if the tint transition has settled at rest.
	#[must_use]
	pub fn is_settled(&self) -> bool {
		self
			.registry
			.is_at_rest(&AnimatorKey::new(self.surface_id, MotionRole::Tint, self.slot))
	}
}
