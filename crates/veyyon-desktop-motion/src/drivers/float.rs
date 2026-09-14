//! Motion driver for popovers, palettes, menus, and dialogs
//! (`MotionRole::Float`).

use std::time::Instant;

use crate::{
	curves::EasingCurve,
	registry::{AnimatorKey, AnimatorRegistry, SurfaceId},
	role::{DurationModel, MotionModel, MotionRole, ResolvedMotion, resolve_motion},
	tokens::MotionTokens,
};

/// One frame of a float popover or dialog transition.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FloatFrame {
	pub opacity:  f32,
	pub offset_y: f32,
	pub settled:  bool,
}

/// Persistent float driver for popovers, palettes, menus, and dialogs
/// (`MotionRole::Float`).
#[derive(Debug)]
pub struct FloatMotion {
	surface_id: SurfaceId,
	slot_base:  u64,
	registry:   AnimatorRegistry,
}

impl Default for FloatMotion {
	fn default() -> Self {
		Self::new(SurfaceId::Palette, 0)
	}
}

impl FloatMotion {
	/// Creates a new float motion driver for the given surface.
	#[must_use]
	pub fn new(surface_id: SurfaceId, slot_base: u64) -> Self {
		Self { surface_id, slot_base, registry: AnimatorRegistry::new() }
	}

	/// Creates a float motion driver pre-initialized at the open or closed
	/// state.
	#[must_use]
	pub fn with_initial(surface_id: SurfaceId, slot_base: u64, open: bool) -> Self {
		let mut registry = AnimatorRegistry::new();
		let target = if open { 1.0 } else { 0.0 };
		let model =
			MotionModel::Duration(DurationModel { duration_ms: 0, curve: EasingCurve::Linear });
		let now = Instant::now();
		registry.get_or_create_with_initial(
			AnimatorKey::new(surface_id, MotionRole::Float, slot_base),
			target,
			target,
			model,
			now,
		);
		registry.get_or_create_with_initial(
			AnimatorKey::new(surface_id, MotionRole::Float, slot_base + 1),
			target,
			target,
			model,
			now,
		);
		Self { surface_id, slot_base, registry }
	}

	/// Samples the current float transition frame.
	pub fn sample(
		&mut self,
		open: bool,
		now: Instant,
		tokens: &MotionTokens,
		reduced: bool,
	) -> FloatFrame {
		let target = if open { 1.0 } else { 0.0 };
		let (model, rise, fade_ms) = match resolve_motion(MotionRole::Float, tokens, reduced) {
			ResolvedMotion::Spring(spring) => {
				(MotionModel::Spring(spring), tokens.float.rise_px, tokens.float.fade_duration_ms)
			},
			ResolvedMotion::FadeOnly { duration_ms } => (
				MotionModel::Duration(DurationModel { duration_ms, curve: EasingCurve::EaseOut }),
				0.0,
				duration_ms,
			),
			ResolvedMotion::Duration { duration_ms, curve } => {
				(MotionModel::Duration(DurationModel { duration_ms, curve }), 0.0, duration_ms)
			},
			ResolvedMotion::Instant | ResolvedMotion::SteadyOn => (
				MotionModel::Duration(DurationModel {
					duration_ms: 0,
					curve:       EasingCurve::Linear,
				}),
				0.0,
				0,
			),
		};
		let (position, _, position_settled) = self
			.registry
			.get_or_create(
				AnimatorKey::new(self.surface_id, MotionRole::Float, self.slot_base),
				target,
				model,
				now,
			)
			.sample_at(now);
		let (opacity, _, opacity_settled) = self
			.registry
			.get_or_create(
				AnimatorKey::new(self.surface_id, MotionRole::Float, self.slot_base + 1),
				target,
				MotionModel::Duration(DurationModel {
					duration_ms: fade_ms,
					curve:       EasingCurve::EaseOut,
				}),
				now,
			)
			.sample_at(now);
		FloatFrame {
			opacity:  opacity.clamp(0.0, 1.0),
			offset_y: (1.0 - position) * rise,
			settled:  position_settled && opacity_settled,
		}
	}

	/// Returns true if all animations have settled at rest.
	#[must_use]
	pub fn is_settled(&self) -> bool {
		self.registry.is_at_rest(&AnimatorKey::new(
			self.surface_id,
			MotionRole::Float,
			self.slot_base,
		)) && self.registry.is_at_rest(&AnimatorKey::new(
			self.surface_id,
			MotionRole::Float,
			self.slot_base + 1,
		))
	}
}
