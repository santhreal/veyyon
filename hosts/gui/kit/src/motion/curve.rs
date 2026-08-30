//! Curves, and the named ones the window uses.
//!
//! A `Curve` is a CSS `cubic-bezier` with the endpoints fixed, evaluated by
//! Newton iteration on x(t) with a bisection fallback, so a name here is the
//! exact curve a browser would draw rather than an approximation of it.

use std::fmt::Debug;

/// A CSS `cubic-bezier(x1, y1, x2, y2)`, with the endpoints fixed at (0,0) and
/// (1,1). Evaluated by Newton iteration on x(t) with a bisection fallback.
///
/// The curves the window uses are named below; this exists so those names are
/// the exact curves a browser would draw, rather than an approximation of them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Curve {
	pub x1: f32,
	pub y1: f32,
	pub x2: f32,
	pub y2: f32,
}

impl Curve {
	pub const fn new(x1: f32, y1: f32, x2: f32, y2: f32) -> Curve {
		Curve { x1, y1, x2, y2 }
	}

	/// Polynomial coefficients of one axis of the unit bezier.
	fn axis(a: f32, b: f32) -> (f32, f32, f32) {
		let c = 3.0 * a;
		let b2 = 3.0 * (b - a) - c;
		(1.0 - c - b2, b2, c)
	}

	fn x_at(self, t: f32) -> f32 {
		let (a, b, c) = Curve::axis(self.x1, self.x2);
		((a * t + b) * t + c) * t
	}

	fn y_at(self, t: f32) -> f32 {
		let (a, b, c) = Curve::axis(self.y1, self.y2);
		((a * t + b) * t + c) * t
	}

	fn dx_at(self, t: f32) -> f32 {
		let (a, b, c) = Curve::axis(self.x1, self.x2);
		(3.0 * a * t + 2.0 * b) * t + c
	}

	fn t_for_x(self, x: f32) -> f32 {
		let mut t = x;
		for _ in 0..8 {
			let error = self.x_at(t) - x;
			if error.abs() < 1e-6 {
				return t;
			}
			let slope = self.dx_at(t);
			if slope.abs() < 1e-6 {
				break;
			}
			t -= error / slope;
		}
		let (mut low, mut high) = (0.0_f32, 1.0_f32);
		for _ in 0..32 {
			let middle = (low + high) / 2.0;
			if self.x_at(middle) < x {
				low = middle;
			} else {
				high = middle;
			}
		}
		(low + high) / 2.0
	}

	/// Eased output for a progress in 0..1, clamped at both ends.
	///
	/// The clamp on the output is load bearing rather than defensive: f32
	/// rounding puts `y_at` a hair above 1.0 near the tail of the sharper
	/// curves, and an opacity above 1.0 is a panic one layer down.
	pub fn at(self, x: f32) -> f32 {
		if x <= 0.0 {
			return 0.0;
		}
		if x >= 1.0 {
			return 1.0;
		}
		self.y_at(self.t_for_x(x)).clamp(0.0, 1.0)
	}
}

/// The entrance curve: leaves fast, lands slow, almost arrived by the halfway
/// point. CSS `cubic-bezier(0.16, 1, 0.3, 1)`.
pub const EXPO_OUT: Curve = Curve::new(0.16, 1.0, 0.3, 1.0);
/// CSS `ease-out`. Widths and heights.
pub const OUT: Curve = Curve::new(0.0, 0.0, 0.58, 1.0);
/// CSS `ease`. Fades, sheets, chips.
pub const EASE: Curve = Curve::new(0.25, 0.1, 0.25, 1.0);
/// CSS `ease-in-out`. A value moving between two resting states, and a scroll.
pub const IN_OUT: Curve = Curve::new(0.42, 0.0, 0.58, 1.0);
/// CSS `ease-in`. Only for something leaving.
pub const IN: Curve = Curve::new(0.42, 0.0, 1.0, 1.0);
/// The curve a colour transition rides. CSS `cubic-bezier(0.4, 0, 0.2, 1)`.
pub const COLOR: Curve = Curve::new(0.4, 0.0, 0.2, 1.0);
/// No curve at all. Only for something that repeats, where an eased period has
/// a visible seam at the wrap.
pub const LINEAR: Curve = Curve::new(0.0, 0.0, 1.0, 1.0);
