use serde::{Deserialize, Serialize};

/// The 7 discrete motion roles defined in the design system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MotionRole {
	Tint,
	Reveal,
	Float,
	Panel,
	Shift,
	Scroll,
	Caret,
}

impl MotionRole {
	/// Returns all motion roles in canonical declaration order.
	pub const fn all() -> [Self; 7] {
		[Self::Tint, Self::Reveal, Self::Float, Self::Panel, Self::Shift, Self::Scroll, Self::Caret]
	}

	/// Returns the role name as used in TOML key headers.
	pub const fn as_str(self) -> &'static str {
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
}

/// Supported easing curves for duration and flip transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EasingCurve {
	EaseOut,
	EaseInOut,
	Linear,
}

impl EasingCurve {
	/// Parses curve name from TOML token string.
	pub fn from_str_name(name: &str) -> Option<Self> {
		match name {
			"ease_out" => Some(Self::EaseOut),
			"ease_in_out" => Some(Self::EaseInOut),
			"linear" => Some(Self::Linear),
			_ => None,
		}
	}

	/// Formats curve as string.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::EaseOut => "ease_out",
			Self::EaseInOut => "ease_in_out",
			Self::Linear => "linear",
		}
	}
}

/// Fallback behavior when reduced motion is preferred by system settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ReducedMotion {
	Instant,
	FadeInstant,
	OpacityOnly,
	Direct,
	SteadyOn,
}

impl ReducedMotion {
	/// Parses reduced motion setting from string.
	pub fn from_str_name(name: &str) -> Option<Self> {
		match name {
			"instant" => Some(Self::Instant),
			"fade_instant" => Some(Self::FadeInstant),
			"opacity_only" => Some(Self::OpacityOnly),
			"direct" => Some(Self::Direct),
			"steady_on" => Some(Self::SteadyOn),
			_ => None,
		}
	}

	/// Formats reduced motion policy as string.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Instant => "instant",
			Self::FadeInstant => "fade_instant",
			Self::OpacityOnly => "opacity_only",
			Self::Direct => "direct",
			Self::SteadyOn => "steady_on",
		}
	}
}

/// Duration-based timing model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DurationModel {
	pub duration_ms: u32,
	pub curve:       EasingCurve,
}

/// Physical spring simulation model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SpringModel {
	pub stiffness: f32,
	pub damping:   f32,
	pub mass:      f32,
}

/// Physical spring combined with vertical rise and opacity fade.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SpringFadeModel {
	pub spring:           SpringModel,
	pub rise_px:          f32,
	pub fade_duration_ms: u32,
}

/// Direct tracking during drag followed by harmonic release.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DirectThenSpringModel {
	pub snap_spring: SpringModel,
}

/// FLIP layout shift model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlipModel {
	pub duration_ms: u32,
	pub curve:       EasingCurve,
}

/// Two-step discrete blinking timing model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TwoStepModel {
	pub period_ms: u32,
}

/// Concrete animation parameter model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum MotionModel {
	Duration(DurationModel),
	Spring(SpringModel),
	SpringFade(SpringFadeModel),
	DirectThenSpring(DirectThenSpringModel),
	Flip(FlipModel),
	TwoStep(TwoStepModel),
}

/// Complete configuration for a single motion role.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MotionRoleConfig {
	pub model:          MotionModel,
	pub reduced_motion: ReducedMotion,
}

/// The 7 motion roles defined in motion.toml.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MotionTokens {
	pub tint:   MotionRoleConfig,
	pub reveal: MotionRoleConfig,
	pub float:  MotionRoleConfig,
	pub panel:  MotionRoleConfig,
	pub shift:  MotionRoleConfig,
	pub scroll: MotionRoleConfig,
	pub caret:  MotionRoleConfig,
}

impl MotionTokens {
	/// Returns the role configuration for the specified motion role.
	pub const fn role(&self, role: MotionRole) -> &MotionRoleConfig {
		match role {
			MotionRole::Tint => &self.tint,
			MotionRole::Reveal => &self.reveal,
			MotionRole::Float => &self.float,
			MotionRole::Panel => &self.panel,
			MotionRole::Shift => &self.shift,
			MotionRole::Scroll => &self.scroll,
			MotionRole::Caret => &self.caret,
		}
	}
}
