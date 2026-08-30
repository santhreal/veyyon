//! Spring presets.
//!
//! A duration token says how long something takes. A spring says how it moves,
//! and keeps moving correctly when the target changes mid-flight — gpui's
//! spring element is keyed by element id and carries position and velocity
//! across a retarget, so a hover that reverses halfway does not jump.
//!
//! Use a spring where the target is interactive and can change before the
//! motion finishes: hover, press, drag, a list reordering under the pointer.
//! Use a [`Motion`](crate::Motion) where the motion has a beginning and an end
//! nothing will interrupt: an entrance, an exit, a scroll glide.
//!
//! Presets are stated as natural frequency and damping ratio rather than as
//! stiffness and viscous damping, because those are the two numbers that
//! describe what you see: how fast, and whether it overshoots. Mass is 1, so
//! `k = ω₀²` and `c = 2ζω₀`.

use gpui::SpringConfig;

/// A spring from its observable parameters.
///
/// `natural_frequency` is ω₀ in radians per second — higher is faster.
/// `damping_ratio` is ζ: below 1 overshoots and oscillates, exactly 1 is the
/// fastest approach with no overshoot, above 1 is slower and never overshoots.
pub const fn canonical(natural_frequency: f32, damping_ratio: f32) -> SpringConfig {
	SpringConfig::new(
		natural_frequency * natural_frequency,
		2.0 * damping_ratio * natural_frequency,
		1.0,
	)
}

/// Press and release. Fast, no overshoot: a button that overshoots reads as
/// unreliable rather than lively.
pub const PRESS: SpringConfig = canonical(34.0, 1.0);

/// Hover and focus washes, and anything small the pointer drives. Slight
/// overshoot, which is what makes it feel physical at this size.
pub const SNAPPY: SpringConfig = canonical(22.0, 0.72);

/// Layout: a row moving, a pane taking its new width, a card settling into
/// place. No overshoot, because geometry that overshoots looks broken.
pub const SMOOTH: SpringConfig = canonical(15.0, 1.0);

/// Large surfaces travelling a long way. Slower, barely underdamped.
pub const GENTLE: SpringConfig = canonical(10.0, 0.9);

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use gpui::SpringState;

	use super::*;

	const PRESETS: &[(&str, SpringConfig, f32)] = &[
		("PRESS", PRESS, 1.0),
		("SNAPPY", SNAPPY, 0.72),
		("SMOOTH", SMOOTH, 1.0),
		("GENTLE", GENTLE, 0.9),
	];

	/// `canonical` round-trips through gpui's own decomposition. This is the
	/// contract the presets are declared against: if the conversion is wrong,
	/// every preset is a different spring than its name claims.
	#[test]
	fn canonical_parameters_round_trip() {
		for (name, config, expected_zeta) in PRESETS {
			let (frequency, zeta) = config.canonical();
			assert!(
				(zeta - expected_zeta).abs() < 1e-4,
				"{name}: damping ratio is {zeta}, declared {expected_zeta}"
			);
			assert!(frequency > 0.0, "{name}: frequency {frequency}");
		}
	}

	/// A preset declared at ζ ≥ 1 never crosses its target. A press or a layout
	/// move that overshoots is the defect these presets exist to avoid, and it
	/// is invisible in a still frame.
	#[test]
	fn critically_damped_presets_never_overshoot() {
		for (name, config, zeta) in PRESETS {
			if *zeta < 1.0 {
				continue;
			}
			let mut state = SpringState { position: 0.0, velocity: 0.0 };
			for _ in 0..600 {
				state = config.step(state, 1.0, 1.0 / 120.0);
				assert!(state.position <= 1.0 + 1e-4, "{name} overshot to {}", state.position);
			}
		}
	}

	/// An underdamped preset does overshoot, and the overshoot is small enough
	/// to read as spring rather than as a bug. Without an upper bound this test
	/// would pass for a spring that flies to 3× its target.
	#[test]
	fn underdamped_presets_overshoot_within_bounds() {
		for (name, config, zeta) in PRESETS {
			if *zeta >= 1.0 {
				continue;
			}
			let mut state = SpringState { position: 0.0, velocity: 0.0 };
			let mut peak = 0.0_f32;
			for _ in 0..600 {
				state = config.step(state, 1.0, 1.0 / 120.0);
				peak = peak.max(state.position);
			}
			assert!(peak > 1.0, "{name} did not overshoot at all (peak {peak})");
			assert!(peak < 1.12, "{name} overshot to {peak}");
		}
	}

	/// Every preset settles, inside a bound, and in the order the table
	/// promises.
	///
	/// The bound is what makes these usable as interaction feedback at all. The
	/// ordering is the contract a component relies on when it picks by name:
	/// `PRESS` arrives before `SNAPPY`, which arrives before `SMOOTH`, which
	/// arrives before `GENTLE`. That is asserted from the table rather than
	/// against per-preset constants, so retuning a preset past its neighbour
	/// fails here instead of quietly reordering the tiers.
	#[test]
	fn every_preset_settles_within_its_budget() {
		let budget = Duration::from_secs(1);
		let start = SpringState { position: 0.0, velocity: 0.0 };
		let mut previous: Option<(&str, Duration)> = None;
		for (name, config, _) in PRESETS {
			let settle = config.settle_time(start, 1.0, 0.001);
			assert!(settle > Duration::ZERO, "{name} claims to be settled already");
			assert!(settle <= budget, "{name} settles in {settle:?}, over {budget:?}");
			if let Some((slower, earlier)) = previous {
				assert!(
					settle > earlier,
					"{name} settles in {settle:?}, no later than {slower} at {earlier:?}"
				);
			}
			previous = Some((name, settle));
		}
	}

	/// The presets are ordered by speed, fastest first. The names promise this
	/// ordering and components pick by name.
	#[test]
	fn presets_are_ordered_by_speed() {
		let frequencies: Vec<f32> = PRESETS
			.iter()
			.map(|(_, config, _)| config.canonical().0)
			.collect();
		for pair in frequencies.windows(2) {
			assert!(pair[0] > pair[1], "out of order: {:?}", frequencies);
		}
	}

	/// Stepping is frame-rate independent: the same elapsed time reaches the
	/// same position whether it arrived in one step or many. A spring that
	/// depends on frame rate moves differently on a 60Hz and a 144Hz display.
	#[test]
	fn stepping_is_frame_rate_independent() {
		let start = SpringState { position: 0.0, velocity: 0.0 };
		for (name, config, _) in PRESETS {
			let coarse = config.step(start, 1.0, 0.1);

			let mut fine = start;
			for _ in 0..100 {
				fine = config.step(fine, 1.0, 0.001);
			}

			assert!(
				(coarse.position - fine.position).abs() < 1e-3,
				"{name}: one 100ms step reached {}, a hundred 1ms steps reached {}",
				coarse.position,
				fine.position
			);
		}
	}
}
