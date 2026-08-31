//! Closed-form motion sampling.
//!
//! Springs are evaluated from their event-time state, never integrated from the
//! previous frame. Sampling at 60 Hz, 120 Hz, or after a dropped frame
//! therefore produces the same position and velocity for the same instant.

use super::{Program, Sample, Spring, Tween, lerp};

pub fn sample(program: Program, x0: f32, v0: f32, target: f32, elapsed_ms: u64) -> Sample {
	match program {
		Program::Spring(spring) => sample_spring(spring, x0, v0, target, elapsed_ms),
		Program::Tween(tween) => sample_tween(tween, x0, target, elapsed_ms),
		Program::Steps(steps) => {
			let count = u64::from(steps.count.max(1));
			let period = u64::from(steps.period_ms.max(1));
			let step = elapsed_ms.saturating_mul(count) / period;
			let phase = (step % count) as f32 / count as f32;
			Sample { value: phase, velocity: 0.0, settled: false }
		},
		Program::Direct => Sample { value: target, velocity: 0.0, settled: true },
	}
}

pub fn sample_spring(spring: Spring, x0: f32, v0: f32, target: f32, elapsed_ms: u64) -> Sample {
	if elapsed_ms >= u64::from(spring.hard_limit_ms) {
		return Sample { value: target, velocity: 0.0, settled: true };
	}
	// The boundary is the event state itself, for every damping regime and with
	// no transcendentals: a retarget samples here on the frame it happens, and
	// reconstructing `x0` and `v0` from the coefficients returns a value near
	// them rather than them.
	if elapsed_ms == 0 {
		let settled =
			(x0 - target).abs() <= spring.epsilon_value && v0.abs() <= spring.epsilon_velocity;
		return if settled {
			Sample { value: target, velocity: 0.0, settled: true }
		} else {
			Sample { value: x0, velocity: v0, settled: false }
		};
	}
	let t = elapsed_ms as f32 / 1_000.0;
	let omega = spring.omega.max(f32::EPSILON);
	let zeta = spring.damping_ratio.max(0.0);
	let y0 = x0 - target;
	let (y, velocity) = if zeta < 1.0 - 1e-4 {
		let alpha = zeta * omega;
		let wd = omega * (1.0 - zeta * zeta).sqrt();
		let a = y0;
		let b = (v0 + alpha * y0) / wd;
		let (sin, cos) = (wd * t).sin_cos();
		let decay = (-alpha * t).exp();
		let y = decay * (a * cos + b * sin);
		// The cosine's coefficient is `v0` and the sine's is
		// `-(alpha * v0 + omega^2 * y0) / wd`, reduced from the derivative by
		// hand. Written as `-alpha * a + b * wd` instead, the two large terms of
		// `b * wd` cancel down to `v0` and take its low bits with them: a
		// retarget then starts from a velocity that is close to the one the
		// event carried rather than the one it carried.
		let velocity = decay * (v0 * cos - ((alpha * v0 + omega * omega * y0) / wd) * sin);
		(y, velocity)
	} else if zeta <= 1.0 + 1e-4 {
		let a = y0;
		let b = v0 + omega * y0;
		let decay = (-omega * t).exp();
		let y = decay * (a + b * t);
		// `b - omega * (a + b * t)` reduces to `v0 - omega * b * t`, and cancels
		// the same way if it is not.
		let velocity = decay * (v0 - omega * b * t);
		(y, velocity)
	} else {
		let root = (zeta * zeta - 1.0).sqrt();
		let r1 = -omega * (zeta - root);
		let r2 = -omega * (zeta + root);
		let c1 = (v0 - r2 * y0) / (r1 - r2);
		let c2 = y0 - c1;
		let e1 = (r1 * t).exp();
		let e2 = (r2 * t).exp();
		(c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2)
	};
	let value = target + y;
	let settled = y.abs() <= spring.epsilon_value && velocity.abs() <= spring.epsilon_velocity;
	if settled {
		Sample { value: target, velocity: 0.0, settled: true }
	} else {
		Sample { value, velocity, settled: false }
	}
}

pub fn sample_tween(tween: Tween, x0: f32, target: f32, elapsed_ms: u64) -> Sample {
	let duration = u64::from(tween.duration_ms);
	if duration == 0 || elapsed_ms >= duration {
		return Sample { value: target, velocity: 0.0, settled: true };
	}
	let progress = elapsed_ms as f32 / duration as f32;
	let eased = tween.curve.at(progress);
	let delta = 0.0005_f32;
	let before = tween.curve.at((progress - delta).max(0.0));
	let after = tween.curve.at((progress + delta).min(1.0));
	let curve_velocity = (after - before) / (2.0 * delta);
	Sample {
		value:    lerp(x0, target, eased),
		velocity: (target - x0) * curve_velocity * (1_000.0 / duration as f32),
		settled:  false,
	}
}
