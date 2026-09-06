//! Persistent float transitions evaluated from the installed motion role table.

use std::time::Instant;

use veyyon_desktop_motion::{
	AnimatorKey, AnimatorRegistry, DurationModel, EasingCurve, MotionModel, MotionRole,
	MotionTokens, ResolvedMotion, SurfaceId, resolve_motion,
};

/// One frame of a float transition. Translation is applied by the GPUI fork.
#[derive(Debug, Clone, Copy)]
pub struct FloatFrame {
	pub opacity:  f32,
	pub offset_y: f32,
	pub settled:  bool,
}

/// Stable animation identity survives removal and reinsertion of the element
/// tree.
#[derive(Debug, Default)]
pub struct FloatMotion {
	registry: AnimatorRegistry,
}

impl FloatMotion {
	/// Reverses from the sampled position and velocity when `open` changes.
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
				AnimatorKey::new(SurfaceId::Palette, MotionRole::Float, 0),
				target,
				model,
				now,
			)
			.sample_at(now);
		let (opacity, _, opacity_settled) = self
			.registry
			.get_or_create(
				AnimatorKey::new(SurfaceId::Palette, MotionRole::Float, 1),
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
}
