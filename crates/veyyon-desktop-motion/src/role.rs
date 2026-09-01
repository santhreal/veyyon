use serde::{Deserialize, Serialize};

use crate::{curves::EasingCurve, error::MotionError, spring::SpringModel};

/// The 7 distinct motion roles declared in plan §7.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MotionRole {
	/// Hover, focus, selection, badge color, scrim.
	Tint,
	/// Expand and collapse, distance-aware.
	Reveal,
	/// Menus, popovers, dialogs, palette, attached cards.
	Float,
	/// Right panel resize, drawer resize, queue resize.
	Panel,
	/// Queue row entering, leaving, or being dragged.
	Shift,
	/// Programmatic jump to a turn or a search hit.
	Scroll,
	/// Streaming caret cadence.
	Caret,
}

/// Exactly the 7 motion roles from §7.1.
pub const ALL_ROLES: [MotionRole; 7] = [
	MotionRole::Tint,
	MotionRole::Reveal,
	MotionRole::Float,
	MotionRole::Panel,
	MotionRole::Shift,
	MotionRole::Scroll,
	MotionRole::Caret,
];

impl MotionRole {
	/// Returns a slice of all 7 valid motion roles.
	#[inline]
	pub const fn all() -> &'static [Self; 7] {
		&ALL_ROLES
	}

	/// Returns the canonical `snake_case` string identifier for this motion
	/// role.
	pub const fn name(&self) -> &'static str {
		match self {
			Self::Tint => "tint",
			Self::Reveal => "reveal",
			Self::Float => "float",
			Self::Panel => "panel",
			Self::Shift => "shift",
			Self::Scroll => "scroll",
			Self::Caret => "caret",
		}
	}

	/// Parses a motion role from its string name.
	///
	/// # Errors
	/// Returns [`MotionError::UnknownRole`] if the string is not one of the 7
	/// valid roles.
	pub fn from_name(s: &str) -> Result<Self, MotionError> {
		match s {
			"tint" => Ok(Self::Tint),
			"reveal" => Ok(Self::Reveal),
			"float" => Ok(Self::Float),
			"panel" => Ok(Self::Panel),
			"shift" => Ok(Self::Shift),
			"scroll" => Ok(Self::Scroll),
			"caret" => Ok(Self::Caret),
			_ => Err(MotionError::UnknownRole(s.to_string())),
		}
	}
}

/// Duration-based timing model with easing curve.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DurationModel {
	pub duration_ms: u32,
	pub curve:       EasingCurve,
}

/// Spring-plus-fade motion model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SpringFadeModel {
	pub spring:           SpringModel,
	pub rise_px:          f32,
	pub fade_duration_ms: u32,
}

/// Direct interaction while active, snapping via spring on release.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DirectThenSpringModel {
	pub snap_spring: SpringModel,
}

/// FLIP (First Last Invert Play) layout transition model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FlipModel {
	pub duration_ms: u32,
	pub curve:       EasingCurve,
}

/// Two-step discrete periodic blink model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TwoStepModel {
	pub period_ms: u32,
}

/// The set of motion models supported across the 7 roles (§8.23).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum MotionModel {
	Duration(DurationModel),
	Spring(SpringModel),
	SpringFade(SpringFadeModel),
	DirectThenSpring(DirectThenSpringModel),
	Flip(FlipModel),
	TwoStep(TwoStepModel),
}

/// Resolved runtime motion variant for a role, honoring reduced motion settings
/// (§8.23).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResolvedMotion {
	/// Instantaneous update with 0ms duration.
	Instant,
	/// Standard duration transition with easing curve.
	Duration { duration_ms: u32, curve: EasingCurve },
	/// Dynamic spring integration.
	Spring(SpringModel),
	/// Plain opacity fade without spatial displacement.
	FadeOnly { duration_ms: u32 },
	/// Steady-on visual state (no blinking).
	SteadyOn,
}

/// Centralized reduced motion resolver selecting the single variant per role
/// (§7.2, §8.23).
///
/// This is the single selection site across the product; call sites never
/// branch on reduced motion.
pub const fn resolve_motion(
	role: MotionRole,
	config: &crate::tokens::MotionTokens,
	reduced_motion: bool,
) -> ResolvedMotion {
	if !reduced_motion {
		return match role {
			MotionRole::Tint => ResolvedMotion::Duration {
				duration_ms: config.tint.duration_ms,
				curve:       config.tint.curve,
			},
			MotionRole::Reveal => ResolvedMotion::Spring(config.reveal),
			MotionRole::Float => ResolvedMotion::Spring(config.float.spring),
			MotionRole::Panel => ResolvedMotion::Spring(config.panel.snap_spring),
			MotionRole::Shift => ResolvedMotion::Duration {
				duration_ms: config.shift.duration_ms,
				curve:       config.shift.curve,
			},
			MotionRole::Scroll => ResolvedMotion::Duration {
				duration_ms: config.scroll.duration_ms,
				curve:       config.scroll.curve,
			},
			MotionRole::Caret => ResolvedMotion::Duration {
				duration_ms: config.caret.period_ms / 2,
				curve:       EasingCurve::Linear,
			},
		};
	}

	// Reduced motion mappings (§7.2)
	match role {
		MotionRole::Tint => ResolvedMotion::Instant,
		MotionRole::Reveal => ResolvedMotion::FadeOnly { duration_ms: 60 },
		MotionRole::Float => ResolvedMotion::FadeOnly { duration_ms: 60 },
		MotionRole::Panel => ResolvedMotion::Instant,
		MotionRole::Shift => ResolvedMotion::Instant,
		MotionRole::Scroll => ResolvedMotion::Instant,
		MotionRole::Caret => ResolvedMotion::SteadyOn,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::tokens::MotionTokens;

	#[test]
	fn test_role_sweep_and_opt_out() {
		let roles = MotionRole::all();
		assert_eq!(roles.len(), 7);

		// Assert exact role identity
		let expected = [
			MotionRole::Tint,
			MotionRole::Reveal,
			MotionRole::Float,
			MotionRole::Panel,
			MotionRole::Shift,
			MotionRole::Scroll,
			MotionRole::Caret,
		];
		assert_eq!(roles, &expected);
	}

	#[test]
	fn test_reduced_motion_mappings() {
		let tokens = MotionTokens::reference();

		// Standard motion
		assert_eq!(resolve_motion(MotionRole::Tint, &tokens, false), ResolvedMotion::Duration {
			duration_ms: 120,
			curve:       EasingCurve::EaseOut,
		});
		assert_eq!(
			resolve_motion(MotionRole::Reveal, &tokens, false),
			ResolvedMotion::Spring(tokens.reveal)
		);
		assert_eq!(
			resolve_motion(MotionRole::Float, &tokens, false),
			ResolvedMotion::Spring(tokens.float.spring)
		);
		assert_eq!(
			resolve_motion(MotionRole::Panel, &tokens, false),
			ResolvedMotion::Spring(tokens.panel.snap_spring)
		);
		assert_eq!(resolve_motion(MotionRole::Shift, &tokens, false), ResolvedMotion::Duration {
			duration_ms: 200,
			curve:       EasingCurve::EaseOut,
		});
		assert_eq!(resolve_motion(MotionRole::Scroll, &tokens, false), ResolvedMotion::Duration {
			duration_ms: 240,
			curve:       EasingCurve::EaseInOut,
		});
		assert_eq!(resolve_motion(MotionRole::Caret, &tokens, false), ResolvedMotion::Duration {
			duration_ms: 450,
			curve:       EasingCurve::Linear,
		});

		// Reduced motion
		assert_eq!(resolve_motion(MotionRole::Tint, &tokens, true), ResolvedMotion::Instant);
		assert_eq!(resolve_motion(MotionRole::Reveal, &tokens, true), ResolvedMotion::FadeOnly {
			duration_ms: 60,
		});
		assert_eq!(resolve_motion(MotionRole::Float, &tokens, true), ResolvedMotion::FadeOnly {
			duration_ms: 60,
		});
		assert_eq!(resolve_motion(MotionRole::Panel, &tokens, true), ResolvedMotion::Instant);
		assert_eq!(resolve_motion(MotionRole::Shift, &tokens, true), ResolvedMotion::Instant);
		assert_eq!(resolve_motion(MotionRole::Scroll, &tokens, true), ResolvedMotion::Instant);
		assert_eq!(resolve_motion(MotionRole::Caret, &tokens, true), ResolvedMotion::SteadyOn);
	}
}
