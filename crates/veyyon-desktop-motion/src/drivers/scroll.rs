//! Motion driver for programmatic smooth scroll jumps (`MotionRole::Scroll`).

use std::time::Instant;

use crate::{
	curves::EasingCurve,
	registry::{AnimatorKey, AnimatorRegistry, SurfaceId},
	role::{DurationModel, MotionModel, MotionRole, ResolvedMotion, resolve_motion},
	tokens::MotionTokens,
};

/// Motion driver for programmatic smooth scroll jumps (`MotionRole::Scroll`).
#[derive(Debug)]
pub struct ScrollMotion {
	surface_id:     SurfaceId,
	slot:           u64,
	registry:       AnimatorRegistry,
	current_offset: f32,
}

impl ScrollMotion {
	/// Creates a new scroll motion driver at `initial_offset`.
	#[must_use]
	pub fn new(surface_id: SurfaceId, slot: u64, initial_offset: f32) -> Self {
		let mut registry = AnimatorRegistry::new();
		let key = AnimatorKey::new(surface_id, MotionRole::Scroll, slot);
		let model = MotionModel::Duration(DurationModel {
			duration_ms: 240,
			curve:       EasingCurve::EaseInOut,
		});
		registry.get_or_create_with_initial(
			key,
			initial_offset,
			initial_offset,
			model,
			Instant::now(),
		);
		Self { surface_id, slot, registry, current_offset: initial_offset }
	}

	/// Initiates a smooth programmatic scroll to `target_offset`.
	pub fn scroll_to(
		&mut self,
		target_offset: f32,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		let key = AnimatorKey::new(self.surface_id, MotionRole::Scroll, self.slot);
		if let ResolvedMotion::Duration { duration_ms, curve } =
			resolve_motion(MotionRole::Scroll, tokens, reduced)
		{
			let model = MotionModel::Duration(DurationModel { duration_ms, curve });
			self.registry.update_target(key, target_offset, model, now);
		} else {
			let model = MotionModel::Duration(DurationModel {
				duration_ms: 0,
				curve:       EasingCurve::Linear,
			});
			let anim =
				self
					.registry
					.get_or_create_with_initial(key, target_offset, target_offset, model, now);
			anim.start_value = target_offset;
			anim.current_value = target_offset;
			anim.target_value = target_offset;
			anim.is_at_rest = true;
			self.current_offset = target_offset;
		}
	}

	/// Sets scroll offset directly from manual user interaction.
	pub fn set_direct(&mut self, offset: f32, now: Instant) {
		self.current_offset = offset;
		let key = AnimatorKey::new(self.surface_id, MotionRole::Scroll, self.slot);
		let model =
			MotionModel::Duration(DurationModel { duration_ms: 0, curve: EasingCurve::Linear });
		let anim = self
			.registry
			.get_or_create_with_initial(key, offset, offset, model, now);
		anim.start_value = offset;
		anim.current_value = offset;
		anim.target_value = offset;
		anim.is_at_rest = true;
	}

	/// Samples the current scroll offset and settled state.
	pub fn sample(&mut self, now: Instant) -> (f32, bool) {
		let key = AnimatorKey::new(self.surface_id, MotionRole::Scroll, self.slot);
		if let Some((pos, _, at_rest)) = self.registry.sample_full(&key, now) {
			self.current_offset = pos;
			(pos, at_rest)
		} else {
			(self.current_offset, true)
		}
	}

	/// Returns the current scroll offset.
	#[must_use]
	pub const fn current_offset(&self) -> f32 {
		self.current_offset
	}

	/// Returns true if the scroll animation has settled at rest.
	#[must_use]
	pub fn is_settled(&self) -> bool {
		self
			.registry
			.is_at_rest(&AnimatorKey::new(self.surface_id, MotionRole::Scroll, self.slot))
	}
}
