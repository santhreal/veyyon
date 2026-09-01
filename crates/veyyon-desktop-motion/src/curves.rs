use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::MotionError;

/// A cubic bezier timing curve defined by control points (x1, y1) and (x2, y2).
/// The start point is implicitly (0.0, 0.0) and the end point is implicitly
/// (1.0, 1.0).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CubicBezier {
	pub x1: f32,
	pub y1: f32,
	pub x2: f32,
	pub y2: f32,
}

impl CubicBezier {
	/// Creates a new cubic bezier curve with validated control points.
	///
	/// # Errors
	/// Returns [`MotionError::InvalidBezierControlPoints`] if `x1` or `x2` falls
	/// outside `[0.0, 1.0]`.
	pub fn new(x1: f32, y1: f32, x2: f32, y2: f32) -> Result<Self, MotionError> {
		if !(0.0..=1.0).contains(&x1) || !(0.0..=1.0).contains(&x2) {
			return Err(MotionError::InvalidBezierControlPoints { x1, x2 });
		}
		Ok(Self { x1, y1, x2, y2 })
	}

	/// Computes x(t) for parameter t in [0.0, 1.0].
	#[inline]
	pub fn sample_x(&self, t: f32) -> f32 {
		let one_minus_t = 1.0 - t;
		(t * t).mul_add(
			t,
			(3.0 * one_minus_t * t * t)
				.mul_add(self.x2, 3.0 * one_minus_t * one_minus_t * t * self.x1),
		)
	}

	/// Computes y(t) for parameter t in [0.0, 1.0].
	#[inline]
	pub fn sample_y(&self, t: f32) -> f32 {
		let one_minus_t = 1.0 - t;
		(t * t).mul_add(
			t,
			(3.0 * one_minus_t * t * t)
				.mul_add(self.y2, 3.0 * one_minus_t * one_minus_t * t * self.y1),
		)
	}

	/// Computes the derivative dx/dt for parameter t in [0.0, 1.0].
	#[inline]
	pub fn sample_derivative_x(&self, t: f32) -> f32 {
		let one_minus_t = 1.0 - t;
		(3.0 * t * t).mul_add(
			1.0 - self.x2,
			(6.0 * one_minus_t * t)
				.mul_add(self.x2 - self.x1, 3.0 * one_minus_t * one_minus_t * self.x1),
		)
	}

	/// Solves for y given x in [0.0, 1.0] using Newton-Raphson with bisection
	/// fallback.
	pub fn solve(&self, x: f32) -> f32 {
		if x <= 0.0 {
			return 0.0;
		}
		if x >= 1.0 {
			return 1.0;
		}

		let mut t_low = 0.0_f32;
		let mut t_high = 1.0_f32;
		let mut t = x;

		// 8 iterations of Newton-Raphson with bisection fallback.
		for _ in 0..8 {
			let current_x = self.sample_x(t) - x;
			if current_x.abs() < 1e-6 {
				return self.sample_y(t);
			}

			let dx = self.sample_derivative_x(t);
			if dx.abs() < 1e-6 {
				break;
			}

			let next_t = t - current_x / dx;
			if next_t <= t_low || next_t >= t_high {
				break;
			}
			t = next_t;
		}

		// Bisection fallback if Newton-Raphson did not converge.
		//
		// The iteration count is the loop bound, not the interval width. Halving
		// [0, 1] reaches 1e-6 in 20 steps, and f32 spacing near 1.0 is about
		// 1.2e-7, so the interval does shrink past the tolerance in practice —
		// but a bound that depends on float spacing is a bound that changes with
		// the input, and this loop runs inside a frame.
		const BISECTION_STEPS: u32 = 24;
		for _ in 0..BISECTION_STEPS {
			if t_high - t_low <= 1e-6 {
				break;
			}
			t = (t_low + t_high) * 0.5;
			if self.sample_x(t) < x {
				t_low = t;
			} else {
				t_high = t;
			}
		}

		self.sample_y(t)
	}
}

/// The set of standard cubic bezier easing curves.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EasingCurve {
	/// Smooth deceleration: (0.0, 0.0, 0.58, 1.0).
	EaseOut,
	/// Symmetric acceleration and deceleration: (0.42, 0.0, 0.58, 1.0).
	EaseInOut,
	/// Smooth acceleration: (0.42, 0.0, 1.0, 1.0).
	EaseIn,
	/// Standard ease curve: (0.25, 0.1, 0.25, 1.0).
	Ease,
	/// Linear progression with constant velocity: (0.0, 0.0, 1.0, 1.0).
	Linear,
	/// Fast deceleration curve: (0.0, 0.0, 0.2, 1.0).
	Decel,
	/// Arbitrary custom cubic bezier curve.
	Custom(f32, f32, f32, f32),
}

impl EasingCurve {
	/// Returns the underlying [`CubicBezier`] curve.
	#[inline]
	pub const fn bezier(&self) -> CubicBezier {
		match *self {
			Self::EaseOut => CubicBezier { x1: 0.0, y1: 0.0, x2: 0.58, y2: 1.0 },
			Self::EaseInOut => CubicBezier { x1: 0.42, y1: 0.0, x2: 0.58, y2: 1.0 },
			Self::EaseIn => CubicBezier { x1: 0.42, y1: 0.0, x2: 1.0, y2: 1.0 },
			Self::Ease => CubicBezier { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1.0 },
			Self::Linear => CubicBezier { x1: 0.0, y1: 0.0, x2: 1.0, y2: 1.0 },
			Self::Decel => CubicBezier { x1: 0.0, y1: 0.0, x2: 0.2, y2: 1.0 },
			Self::Custom(x1, y1, x2, y2) => CubicBezier { x1, y1, x2, y2 },
		}
	}

	/// Evaluates the curve output y at normalized time t in [0.0, 1.0].
	#[inline]
	pub fn evaluate(&self, t: f32) -> f32 {
		match self {
			Self::Linear => t.clamp(0.0, 1.0),
			_ => self.bezier().solve(t),
		}
	}

	/// Returns the canonical `snake_case` name for standard curves.
	pub const fn name(&self) -> &'static str {
		match self {
			Self::EaseOut => "ease_out",
			Self::EaseInOut => "ease_in_out",
			Self::EaseIn => "ease_in",
			Self::Ease => "ease",
			Self::Linear => "linear",
			Self::Decel => "decel",
			Self::Custom(..) => "custom",
		}
	}

	/// Parses an easing curve name from string.
	pub fn from_name(s: &str) -> Result<Self, MotionError> {
		match s {
			"ease_out" => Ok(Self::EaseOut),
			"ease_in_out" => Ok(Self::EaseInOut),
			"ease_in" => Ok(Self::EaseIn),
			"ease" => Ok(Self::Ease),
			"linear" => Ok(Self::Linear),
			"decel" => Ok(Self::Decel),
			_ => Err(MotionError::UnknownCurve(s.to_string())),
		}
	}
}

impl Serialize for EasingCurve {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		serializer.serialize_str(self.name())
	}
}

impl<'de> Deserialize<'de> for EasingCurve {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		let s = String::deserialize(deserializer)?;
		Self::from_name(&s).map_err(serde::de::Error::custom)
	}
}

impl From<veyyon_desktop_tokens::EasingCurve> for EasingCurve {
	fn from(c: veyyon_desktop_tokens::EasingCurve) -> Self {
		match c {
			veyyon_desktop_tokens::EasingCurve::EaseOut => Self::EaseOut,
			veyyon_desktop_tokens::EasingCurve::EaseInOut => Self::EaseInOut,
			veyyon_desktop_tokens::EasingCurve::Linear => Self::Linear,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_bezier_endpoints() {
		let curve = EasingCurve::EaseOut;
		assert_eq!(curve.evaluate(0.0), 0.0);
		assert_eq!(curve.evaluate(1.0), 1.0);

		let linear = EasingCurve::Linear;
		assert_eq!(linear.evaluate(0.0), 0.0);
		assert_eq!(linear.evaluate(0.5), 0.5);
		assert_eq!(linear.evaluate(1.0), 1.0);
	}

	#[test]
	fn test_curve_monotonicity() {
		let curves = [
			EasingCurve::EaseOut,
			EasingCurve::EaseInOut,
			EasingCurve::EaseIn,
			EasingCurve::Ease,
			EasingCurve::Linear,
			EasingCurve::Decel,
		];

		for curve in &curves {
			let mut prev = -0.001;
			for step in 0..=100 {
				let t = step as f32 / 100.0;
				let val = curve.evaluate(t);
				assert!(
					val >= prev - 1e-5,
					"Curve {curve:?} decreased at t={t}: prev={prev}, curr={val}"
				);
				prev = val;
			}
		}
	}
}
