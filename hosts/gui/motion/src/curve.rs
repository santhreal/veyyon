//! Timing curves.
//!
//! A curve maps linear progress to eased progress. Both are 0..1, and the
//! output is clamped to that range: gpui's animation element asserts its delta
//! is in 0..1 and aborts otherwise, and f32 rounding pushes a cubic sample a
//! hair past 1.0 near the end of a curve.

/// A CSS `cubic-bezier(x1, y1, x2, y2)` timing function.
///
/// The endpoints are fixed at (0,0) and (1,1), so only the two control points
/// are named — the same four numbers CSS takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Curve {
	pub x1: f32,
	pub y1: f32,
	pub x2: f32,
	pub y2: f32,
}

impl Curve {
	pub const fn new(x1: f32, y1: f32, x2: f32, y2: f32) -> Self {
		Self { x1, y1, x2, y2 }
	}

	/// Polynomial coefficients of one axis, from its two control values.
	const fn coefficients(a: f32, b: f32) -> (f32, f32, f32) {
		let c = 3.0 * a;
		let b2 = 3.0 * (b - a) - c;
		let a3 = 1.0 - c - b2;
		(a3, b2, c)
	}

	fn sample(a: f32, b: f32, t: f32) -> f32 {
		let (a3, b2, c) = Self::coefficients(a, b);
		((a3 * t + b2) * t + c) * t
	}

	fn sample_derivative(a: f32, b: f32, t: f32) -> f32 {
		let (a3, b2, c) = Self::coefficients(a, b);
		(3.0 * a3 * t + 2.0 * b2) * t + c
	}

	/// The curve parameter `t` at which the curve's x equals `x`.
	///
	/// Newton-Raphson, falling back to bisection when the derivative vanishes.
	/// x(t) is monotonic for any valid CSS bezier, so bisection always
	/// converges.
	fn solve(&self, x: f32) -> f32 {
		let mut t = x;
		for _ in 0..8 {
			let error = Self::sample(self.x1, self.x2, t) - x;
			if error.abs() < 1e-6 {
				return t;
			}
			let derivative = Self::sample_derivative(self.x1, self.x2, t);
			if derivative.abs() < 1e-6 {
				break;
			}
			t -= error / derivative;
		}

		let (mut low, mut high) = (0.0_f32, 1.0_f32);
		for _ in 0..32 {
			let mid = 0.5 * (low + high);
			if Self::sample(self.x1, self.x2, mid) < x {
				low = mid;
			} else {
				high = mid;
			}
		}
		0.5 * (low + high)
	}

	/// Eased progress at linear progress `x`.
	pub fn eval(&self, x: f32) -> f32 {
		if x <= 0.0 {
			return 0.0;
		}
		if x >= 1.0 {
			return 1.0;
		}
		Self::sample(self.y1, self.y2, self.solve(x)).clamp(0.0, 1.0)
	}

	/// This curve as the closure gpui's `Animation::with_easing` takes.
	pub fn easing(self) -> impl Fn(f32) -> f32 + 'static {
		move |x| self.eval(x)
	}
}

/// `linear`. Only for a repeating timeline whose per-element phase is eased by
/// the animator instead.
pub const LINEAR: Curve = Curve::new(0.0, 0.0, 1.0, 1.0);

/// CSS `ease`. Symmetric and unopinionated; the fallback when nothing else
/// fits.
pub const EASE: Curve = Curve::new(0.25, 0.1, 0.25, 1.0);

/// CSS `ease-out`. Layout that changes size — panes, splits, disclosure.
pub const EASE_OUT: Curve = Curve::new(0.0, 0.0, 0.58, 1.0);

/// CSS `ease-in-out`. Motion with a start and a landing, i.e. a scroll glide.
pub const EASE_IN_OUT: Curve = Curve::new(0.42, 0.0, 0.58, 1.0);

/// `cubic-bezier(0.16, 1, 0.3, 1)` — near-instant departure, long settle.
///
/// The entrance curve. Almost all of the distance is covered in the first
/// third of the duration, which is what makes an entrance read as immediate
/// even when it takes 200ms.
pub const EXPO_OUT: Curve = Curve::new(0.16, 1.0, 0.3, 1.0);

/// `cubic-bezier(0.4, 0, 0.2, 1)` — Tailwind's default transition curve.
///
/// Colour and opacity blends on interactive surfaces. Named because the whole
/// web is calibrated to it, so a hover that uses anything else feels wrong
/// beside a browser.
pub const STANDARD: Curve = Curve::new(0.4, 0.0, 0.2, 1.0);

#[cfg(test)]
mod tests {
	use super::*;

	/// Every curve passes through both endpoints exactly. gpui's animation
	/// element asserts its delta is within 0..1, so a curve that overshoots at
	/// either end aborts the process rather than looking wrong.
	#[test]
	fn curves_are_pinned_at_both_endpoints() {
		for curve in [LINEAR, EASE, EASE_OUT, EASE_IN_OUT, EXPO_OUT, STANDARD] {
			assert_eq!(curve.eval(0.0), 0.0, "{curve:?} at 0");
			assert_eq!(curve.eval(1.0), 1.0, "{curve:?} at 1");
		}
	}

	/// Output stays inside 0..1 across the whole domain, including out-of-range
	/// input. `EXPO_OUT` samples above 1.0 in f32 near the end of its curve
	/// without the clamp in `eval`.
	#[test]
	fn output_stays_in_range_across_the_domain() {
		for curve in [LINEAR, EASE, EASE_OUT, EASE_IN_OUT, EXPO_OUT, STANDARD] {
			for step in -10..=1010 {
				let x = step as f32 / 1000.0;
				let y = curve.eval(x);
				assert!((0.0..=1.0).contains(&y), "{curve:?} at {x} produced {y}");
			}
		}
	}

	/// A CSS bezier is monotonic in x, so eased progress never moves backwards.
	/// A non-monotonic curve makes an entrance visibly stutter.
	#[test]
	fn eased_progress_never_decreases() {
		for curve in [LINEAR, EASE, EASE_OUT, EASE_IN_OUT, EXPO_OUT, STANDARD] {
			let mut previous = 0.0;
			for step in 0..=1000 {
				let y = curve.eval(step as f32 / 1000.0);
				assert!(y >= previous - 1e-5, "{curve:?} fell from {previous} to {y}");
				previous = y;
			}
		}
	}

	/// `LINEAR` is the identity. This is the control: it fails if `solve` or
	/// `sample` is wrong in a way the shaped curves would hide.
	#[test]
	fn linear_is_the_identity() {
		for step in 0..=100 {
			let x = step as f32 / 100.0;
			assert!((LINEAR.eval(x) - x).abs() < 1e-4, "linear at {x}");
		}
	}

	/// `EXPO_OUT` front-loads its distance: it is above the identity at every
	/// interior point, so at any moment during the animation more of the travel
	/// is already done than a linear curve would have done. That is the property
	/// the entrance tokens rely on, and it is asserted across the domain rather
	/// than at one sampled point.
	#[test]
	fn expo_out_front_loads_its_distance() {
		for step in 1..100 {
			let x = step as f32 / 100.0;
			assert!(EXPO_OUT.eval(x) > x, "at {x}: {} is not ahead of linear", EXPO_OUT.eval(x));
		}
		// And the shape is pronounced, not a hair above linear: near half the
		// distance in the first tenth, nearly all of it by the midpoint.
		assert!(EXPO_OUT.eval(0.1) > 0.45, "at 0.1: {}", EXPO_OUT.eval(0.1));
		assert!(EXPO_OUT.eval(0.5) > 0.9, "at 0.5: {}", EXPO_OUT.eval(0.5));
	}

	/// `EASE_IN_OUT` is symmetric about its midpoint, which is what makes a
	/// scroll glide start and land at the same rate.
	#[test]
	fn ease_in_out_is_symmetric() {
		assert!((EASE_IN_OUT.eval(0.5) - 0.5).abs() < 1e-3);
		for step in 1..50 {
			let x = step as f32 / 100.0;
			let low = EASE_IN_OUT.eval(x);
			let high = EASE_IN_OUT.eval(1.0 - x);
			assert!((low + high - 1.0).abs() < 2e-3, "asymmetric at {x}: {low} vs {high}");
		}
	}
}
