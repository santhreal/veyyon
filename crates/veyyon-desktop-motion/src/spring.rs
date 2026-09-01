use serde::{Deserialize, Serialize};

use crate::error::MotionError;

/// The physical state of a spring at a given point in time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpringState {
	/// Current displacement/value.
	pub position: f32,
	/// Current instantaneous velocity in units per second.
	pub velocity: f32,
}

/// A physical damped harmonic oscillator model characterized by stiffness,
/// damping, and mass.
///
/// Integrates using the exact closed-form analytic solution to the differential
/// equation: m d²x/dt² + c dx/dt + k (x - `x_target`) = 0
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SpringModel {
	/// Spring stiffness (spring constant k). Must be positive.
	pub stiffness: f32,
	/// Damping coefficient (c). Must be non-negative.
	pub damping:   f32,
	/// Moving mass (m). Must be positive.
	pub mass:      f32,
}

impl SpringModel {
	/// Creates a new `SpringModel` validating physical invariants.
	///
	/// # Errors
	/// Returns [`MotionError::InvalidSpringParameters`] if stiffness <= 0,
	/// damping < 0, or mass <= 0.
	pub fn new(stiffness: f32, damping: f32, mass: f32) -> Result<Self, MotionError> {
		if stiffness <= 0.0 || damping < 0.0 || mass <= 0.0 {
			return Err(MotionError::InvalidSpringParameters { stiffness, damping, mass });
		}
		Ok(Self { stiffness, damping, mass })
	}

	/// Returns undamped natural angular frequency `omega_0` = sqrt(k / m).
	#[inline]
	pub fn natural_frequency(&self) -> f32 {
		let m = self.mass.max(0.001);
		(self.stiffness / m).sqrt()
	}

	/// Returns dimensionless damping ratio zeta = c / (2 * sqrt(k * m)).
	#[inline]
	pub fn damping_ratio(&self) -> f32 {
		let m = self.mass.max(0.001);
		self.damping / (2.0 * (self.stiffness * m).sqrt())
	}

	/// Evaluates the exact spring position and velocity at elapsed time `t`
	/// seconds.
	///
	/// Uses the closed-form analytic solution, ensuring zero numerical drift and
	/// timestep independence.
	#[allow(
		clippy::many_single_char_names,
		reason = "Standard harmonic oscillator physics variables"
	)]
	pub fn evaluate(&self, x0: f32, v0: f32, target: f32, t: f32) -> SpringState {
		let initial_offset = x0 - target;
		if t <= 0.0 {
			return SpringState { position: x0, velocity: v0 };
		}

		let k = self.stiffness;
		let c = self.damping;
		let m = self.mass.max(0.001);

		let omega_0 = (k / m).sqrt();
		let zeta = c / (2.0 * (k * m).sqrt());

		if zeta < 0.9999 {
			// Underdamped regime (zeta < 1)
			let omega_d = omega_0 * (1.0 - zeta * zeta).sqrt();
			let a = initial_offset;
			let b = (zeta * omega_0).mul_add(initial_offset, v0) / omega_d;
			let decay = (-zeta * omega_0 * t).exp();

			let pos = decay * a.mul_add((omega_d * t).cos(), b * (omega_d * t).sin());
			let vel = (-zeta * omega_0).mul_add(
				pos,
				decay * (b * omega_d).mul_add((omega_d * t).cos(), -a * omega_d * (omega_d * t).sin()),
			);

			SpringState { position: target + pos, velocity: vel }
		} else if zeta > 1.0001 {
			// Overdamped regime (zeta > 1)
			let z_sq = (zeta * zeta - 1.0).sqrt();
			let r1 = -omega_0 * (zeta - z_sq);
			let r2 = -omega_0 * (zeta + z_sq);

			let c2 = (v0 - r1 * initial_offset) / (r2 - r1);
			let c1 = initial_offset - c2;

			let e1 = (r1 * t).exp();
			let e2 = (r2 * t).exp();

			let pos = c1 * e1 + c2 * e2;
			let vel = (c2 * r2).mul_add(e2, c1 * r1 * e1);

			SpringState { position: target + pos, velocity: vel }
		} else {
			// Critically damped regime (zeta ~= 1)
			let c1 = initial_offset;
			let c2 = v0 + omega_0 * initial_offset;
			let decay = (-omega_0 * t).exp();

			let pos = (c1 + c2 * t) * decay;
			let vel = (c2 - omega_0 * (c1 + c2 * t)) * decay;

			SpringState { position: target + pos, velocity: vel }
		}
	}

	/// Checks if the spring has settled at the target within the rest threshold.
	/// Rest criterion (§8.23): |x(t) - target| < 0.001 px and |v(t)| < 0.01
	/// px/s.
	#[inline]
	pub fn is_at_rest(&self, state: &SpringState, target: f32) -> bool {
		(state.position - target).abs() < 0.001 && state.velocity.abs() < 0.01
	}

	/// Computes the elapsed time in seconds to reach rest within
	/// `max_time_seconds`, or `None` when it does not settle in that window.
	///
	/// The sweep counts integer steps rather than accumulating `t += dt`. An
	/// accumulated f32 stops advancing entirely once `t` passes roughly 16384
	/// seconds, because 0.001 is then below the spacing between adjacent f32
	/// values, and the loop becomes infinite for a caller who passed a large
	/// window. A step index also makes each sample exactly `n * dt` instead of
	/// the running sum of n additions.
	pub fn time_to_rest(&self, x0: f32, v0: f32, target: f32, max_time_seconds: f32) -> Option<f32> {
		const STEP_SECONDS: f32 = 0.001;
		const VERIFY_STEP_SECONDS: f32 = 0.002;
		const VERIFY_STEPS: u32 = 10;

		if !max_time_seconds.is_finite() || max_time_seconds < 0.0 {
			return None;
		}
		let step_count = (max_time_seconds / STEP_SECONDS).floor();
		if !step_count.is_finite() {
			return None;
		}
		let step_count = step_count.clamp(0.0, f32::from(u16::MAX) * 16.0) as u32;

		for step in 0..=step_count {
			let t = step as f32 * STEP_SECONDS;
			let state = self.evaluate(x0, v0, target, t);
			if !self.is_at_rest(&state, target) {
				continue;
			}

			// A zero-crossing satisfies the rest criterion for one instant. Rest
			// means it is still at rest 20ms later, sampled every 2ms.
			let stays_at_rest = (1..=VERIFY_STEPS).all(|k| {
				let verify_t = (k as f32).mul_add(VERIFY_STEP_SECONDS, t);
				if verify_t > max_time_seconds {
					return true;
				}
				self.is_at_rest(&self.evaluate(x0, v0, target, verify_t), target)
			});
			if stays_at_rest {
				return Some(t);
			}
		}
		None
	}

	/// Returns the exponential decay envelope amplitude for underdamped
	/// oscillations.
	#[inline]
	pub fn decay_envelope(&self, x0: f32, target: f32, t: f32) -> f32 {
		let initial_offset = (x0 - target).abs();
		let omega_0 = self.natural_frequency();
		let zeta = self.damping_ratio();
		if zeta < 0.9999 {
			let amplitude = initial_offset / zeta.mul_add(-zeta, 1.0).sqrt();
			amplitude * (-zeta * omega_0 * t).exp()
		} else {
			initial_offset * (-omega_0 * t).exp()
		}
	}
}

impl From<veyyon_desktop_tokens::SpringModel> for SpringModel {
	fn from(s: veyyon_desktop_tokens::SpringModel) -> Self {
		Self { stiffness: s.stiffness, damping: s.damping, mass: s.mass }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_spring_evaluation_at_t0() {
		let spring = SpringModel::new(220.0, 26.0, 1.0).unwrap();
		let state = spring.evaluate(0.0, 50.0, 100.0, 0.0);
		assert_eq!(state.position, 0.0);
		assert_eq!(state.velocity, 50.0);
	}

	#[test]
	fn test_spring_convergence_and_determinism() {
		let spring = SpringModel::new(220.0, 26.0, 1.0).unwrap();
		let run1 = spring.evaluate(0.0, 0.0, 100.0, 0.5);
		let run2 = spring.evaluate(0.0, 0.0, 100.0, 0.5);
		assert_eq!(run1, run2);
		assert!((run1.position - 100.0).abs() < 5.0);
	}

	#[test]
	fn test_spring_interruption_continuity() {
		let spring = SpringModel::new(220.0, 26.0, 1.0).unwrap();
		let t_interrupt = 0.050; // 50ms in
		let s1 = spring.evaluate(0.0, 0.0, 100.0, t_interrupt);

		// Interrupt and reverse toward 0.0 with 0.0 elapsed time
		let s2 = spring.evaluate(s1.position, s1.velocity, 0.0, 0.0);

		assert!(
			(s2.position - s1.position).abs() < 1e-5,
			"Position discontinuity on spring interruption"
		);
		assert!(
			(s2.velocity - s1.velocity).abs() < 1e-5,
			"Velocity discontinuity on spring interruption"
		);
	}

	#[test]
	fn test_underdamped_envelope_bound() {
		let spring = SpringModel::new(220.0, 26.0, 1.0).unwrap();
		let x0 = 0.0;
		let target = 100.0;

		for step in 1..=80 {
			let t = step as f32 * 0.01;
			let state = spring.evaluate(x0, 0.0, target, t);
			let displacement = (state.position - target).abs();
			let envelope = spring.decay_envelope(x0, target, t);
			assert!(
				displacement <= envelope + 0.001,
				"Displacement {displacement} exceeded envelope {envelope} at t={t}"
			);
		}
	}

	/// A settle sweep that accumulates `t += 0.001` in f32 stops advancing once
	/// `t` passes about 16384 seconds, because the increment falls below the
	/// spacing between adjacent f32 values there. The loop then never ends, and
	/// the only symptom is a frame that never returns. Assert the bound.
	#[test]
	fn a_settle_sweep_over_an_absurd_window_terminates() {
		let spring = SpringModel::new(220.0, 26.0, 1.0).expect("valid spring parameters");

		// Well past the f32 absorption point for a 1ms increment.
		let settled = spring.time_to_rest(0.0, 0.0, 100.0, 100_000.0);
		assert!(settled.is_some(), "an overdamped-enough spring settles inside the window");
		if let Some(t) = settled {
			assert!(t > 0.0 && t < 5.0, "settle time {t}s is not plausible for this spring");
		}

		// A window that cannot be stepped at all still returns.
		assert_eq!(spring.time_to_rest(0.0, 0.0, 100.0, 0.0), None);
		assert_eq!(spring.time_to_rest(0.0, 0.0, 100.0, f32::INFINITY), None);
		assert_eq!(spring.time_to_rest(0.0, 0.0, 100.0, f32::NAN), None);
		assert_eq!(spring.time_to_rest(0.0, 0.0, 100.0, -1.0), None);

		// A spring already at its target rests at the first sample.
		assert_eq!(spring.time_to_rest(100.0, 0.0, 100.0, 1.0), Some(0.0));
	}
}
