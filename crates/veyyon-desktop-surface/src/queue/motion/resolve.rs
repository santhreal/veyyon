//! Reduced-motion policy and motion role model resolution for queue transitions
//! (§7.1, §7.3).

use veyyon_desktop_motion::{
	DurationModel, EasingCurve, MotionModel, MotionRole, MotionTokens, ResolvedMotion,
	resolve_motion,
};

/// Resolves the motion model for a section reveal transition.
#[must_use]
pub const fn reveal_model(tokens: &MotionTokens, reduced_motion: bool) -> MotionModel {
	match resolve_motion(MotionRole::Reveal, tokens, reduced_motion) {
		ResolvedMotion::Spring(s) => MotionModel::Spring(s),
		ResolvedMotion::FadeOnly { duration_ms } => {
			MotionModel::Duration(DurationModel { duration_ms, curve: EasingCurve::EaseOut })
		},
		ResolvedMotion::Duration { duration_ms, curve } => {
			MotionModel::Duration(DurationModel { duration_ms, curve })
		},
		_ => {
			MotionModel::Duration(DurationModel { duration_ms: 0, curve: EasingCurve::Linear })
		},
	}
}

/// Resolves the motion model for a slot tint transition.
#[must_use]
pub const fn tint_model(tokens: &MotionTokens, reduced_motion: bool) -> MotionModel {
	let resolved = resolve_motion(MotionRole::Tint, tokens, reduced_motion);
	match resolved {
		ResolvedMotion::Instant => {
			MotionModel::Duration(DurationModel { duration_ms: 0, curve: EasingCurve::Linear })
		},
		ResolvedMotion::Duration { duration_ms, curve } => {
			MotionModel::Duration(DurationModel { duration_ms, curve })
		},
		_ => MotionModel::Duration(DurationModel {
			duration_ms: 120,
			curve:       EasingCurve::EaseOut,
		}),
	}
}
