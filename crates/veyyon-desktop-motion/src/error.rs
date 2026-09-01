use thiserror::Error;

/// Errors arising in the motion physics integrator, curve evaluation, and token
/// parsing.
#[derive(Debug, Error, PartialEq)]
pub enum MotionError {
	/// Spring parameters are non-physical (stiffness <= 0, damping < 0, or mass
	/// <= 0).
	#[error(
		"invalid spring parameters: stiffness {stiffness} <= 0, damping {damping} < 0, or mass \
		 {mass} <= 0; stiffness and mass must be positive, damping must be non-negative"
	)]
	InvalidSpringParameters { stiffness: f32, damping: f32, mass: f32 },

	/// Cubic bezier X coordinates are outside the required unit interval [0.0,
	/// 1.0].
	#[error(
		"invalid cubic bezier control points: x1={x1}, x2={x2}; X coordinates must lie within [0.0, \
		 1.0]"
	)]
	InvalidBezierControlPoints { x1: f32, x2: f32 },

	/// Motion role identifier string is unknown.
	#[error(
		"unknown motion role '{0}'; expected one of: tint, reveal, float, panel, shift, scroll, \
		 caret"
	)]
	UnknownRole(String),

	/// Required motion role is missing from the token table.
	#[error(
		"missing required motion role '{0}' in motion.toml; declare [role.{0}] with valid parameters"
	)]
	MissingRole(String),

	/// Failed to parse motion token definition.
	#[error(
		"failed to parse motion token configuration: {0}; verify motion.toml format against §8.20 \
		 schema"
	)]
	ParseError(String),

	/// Easing curve name is unknown.
	#[error(
		"unknown easing curve '{0}'; expected one of: ease_out, ease_in_out, ease_in, ease, linear, \
		 decel"
	)]
	UnknownCurve(String),
}
