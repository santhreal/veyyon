//! Motion driver for section reveal and collapse (`MotionRole::Reveal`).

use std::time::Instant;

use crate::{
	curves::EasingCurve,
	registry::{AnimatorKey, AnimatorRegistry, SurfaceId},
	role::{DurationModel, MotionModel, MotionRole, ResolvedMotion, resolve_motion},
	spring::SpringModel,
	tokens::MotionTokens,
};

/// Motion driver for section reveal and collapse (`MotionRole::Reveal`).
#[derive(Debug)]
pub struct RevealMotion {
	surface_id: SurfaceId,
	slot:       u64,
	registry:   AnimatorRegistry,
	expanded:   bool,
	fade_only:  bool,
}

impl RevealMotion {
	/// Creates a new reveal motion driver.
	#[must_use]
	pub fn new(surface_id: SurfaceId, slot: u64, initially_expanded: bool) -> Self {
		let mut registry = AnimatorRegistry::new();
		let target = if initially_expanded { 1.0 } else { 0.0 };
		let key = AnimatorKey::new(surface_id, MotionRole::Reveal, slot);
		let model =
			MotionModel::Spring(SpringModel { stiffness: 220.0, damping: 26.0, mass: 1.0 });
		registry.get_or_create_with_initial(key, target, target, model, Instant::now());
		Self { surface_id, slot, registry, expanded: initially_expanded, fade_only: false }
	}

	/// Toggles expand/collapse state and returns new expanded status.
	pub fn toggle(&mut self, tokens: &MotionTokens, reduced: bool, now: Instant) -> bool {
		self.set_expanded(!self.expanded, tokens, reduced, now);
		self.expanded
	}

	/// Sets explicit expand/collapse state.
	pub fn set_expanded(
		&mut self,
		expanded: bool,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		self.expanded = expanded;
		let target = if expanded { 1.0 } else { 0.0 };
		let key = AnimatorKey::new(self.surface_id, MotionRole::Reveal, self.slot);
		let resolved = resolve_motion(MotionRole::Reveal, tokens, reduced);
		self.fade_only = matches!(resolved, ResolvedMotion::FadeOnly { .. });
		let model = match resolved {
			ResolvedMotion::Spring(s) => MotionModel::Spring(s),
			ResolvedMotion::FadeOnly { duration_ms } => {
				MotionModel::Duration(DurationModel { duration_ms, curve: EasingCurve::EaseOut })
			},
			ResolvedMotion::Duration { duration_ms, curve } => {
				MotionModel::Duration(DurationModel { duration_ms, curve })
			},
			ResolvedMotion::Instant | ResolvedMotion::SteadyOn => {
				MotionModel::Duration(DurationModel {
					duration_ms: 0,
					curve:       EasingCurve::Linear,
				})
			},
		};
		self.registry.update_target(key, target, model, now);
	}

	/// Samples reveal progress (0.0 = collapsed, 1.0 = expanded) and settled
	/// state.
	pub fn sample(&mut self, now: Instant) -> (f32, bool) {
		let key = AnimatorKey::new(self.surface_id, MotionRole::Reveal, self.slot);
		if let Some((pos, _, at_rest)) = self.registry.sample_full(&key, now) {
			(pos, at_rest)
		} else {
			let fallback = if self.expanded { 1.0 } else { 0.0 };
			(fallback, true)
		}
	}

	/// Whether reveal progress changes geometry rather than only opacity.
	pub const fn animates_height(&self) -> bool {
		!self.fade_only
	}

	/// Returns true if currently targeted as expanded.
	#[must_use]
	pub const fn is_expanded(&self) -> bool {
		self.expanded
	}

	/// Returns true if the reveal animation has settled at rest.
	#[must_use]
	pub fn is_settled(&self) -> bool {
		self
			.registry
			.is_at_rest(&AnimatorKey::new(self.surface_id, MotionRole::Reveal, self.slot))
	}
}
