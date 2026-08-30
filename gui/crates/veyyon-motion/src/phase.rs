//! Loader phase math.
//!
//! A repeating loader hands its animator one raw phase per frame and every cell
//! derives its own value from it. That derivation is arithmetic, so it lives
//! here, apart from gpui, and is tested without a window.

/// Phase of cell `index` when each successive cell trails the one before it by
/// `step` of the period.
///
/// Wraps, so a wave leaving one end of a row arrives at the other.
pub fn stagger(phase: f32, index: usize, step: f32) -> f32 {
	(phase - index as f32 * step).rem_euclid(1.0)
}

/// A phase turned into a there-and-back ramp: 0 at both ends, 1 in the middle.
///
/// This is what makes a pulse breathe rather than snap back to its floor when
/// the period wraps.
pub fn triangle(phase: f32) -> f32 {
	let phase = phase.rem_euclid(1.0);
	if phase < 0.5 {
		phase * 2.0
	} else {
		(1.0 - phase) * 2.0
	}
}

/// A travelling wave front: 1 at the cell the front is passing, falling to 0
/// `width` away from it in either direction.
///
/// `width` is a fraction of the period. Wider is a softer, longer wave.
pub fn crest(phase: f32, width: f32) -> f32 {
	if width <= 0.0 {
		return 0.0;
	}
	let phase = phase.rem_euclid(1.0);
	let distance = phase.min(1.0 - phase);
	(1.0 - distance / width).clamp(0.0, 1.0)
}

/// Maps a 0..1 ramp onto a floor..ceiling range, so a pulse dims rather than
/// disappearing.
pub fn between(floor: f32, ceiling: f32, ramp: f32) -> f32 {
	floor + (ceiling - floor) * ramp.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Every cell of a staggered row is inside the period, including behind the
	/// front where the raw subtraction goes negative. A phase outside 0..1
	/// indexes past the end of a colour ramp.
	#[test]
	fn staggered_phases_stay_inside_the_period() {
		for cells in [1_usize, 3, 8, 24] {
			let step = 1.0 / cells as f32;
			for raw in 0..100 {
				let phase = raw as f32 / 100.0;
				for index in 0..cells {
					let value = stagger(phase, index, step);
					assert!(
						(0.0..1.0).contains(&value),
						"cell {index} of {cells} at {phase} produced {value}"
					);
				}
			}
		}
	}

	/// A stagger of zero puts every cell in phase. This is the degenerate case
	/// a caller reaches by dividing by a cell count it has not populated yet.
	#[test]
	fn a_zero_stagger_holds_every_cell_in_phase() {
		for index in 0..8 {
			assert_eq!(stagger(0.4, index, 0.0), 0.4);
		}
	}

	/// The triangle ramp is continuous across the wrap. A discontinuity there
	/// is a visible flicker once per period, which is the failure this shape
	/// exists to avoid.
	#[test]
	fn the_triangle_ramp_is_continuous_across_the_wrap() {
		assert_eq!(triangle(0.0), 0.0);
		assert_eq!(triangle(1.0), 0.0);
		assert!((triangle(0.5) - 1.0).abs() < 1e-6);
		assert!((triangle(0.999) - triangle(0.001)).abs() < 0.01);
	}

	/// The ramp is symmetric, so a pulse brightens and dims at the same rate.
	#[test]
	fn the_triangle_ramp_is_symmetric() {
		for step in 0..=50 {
			let phase = step as f32 / 100.0;
			assert!((triangle(phase) - triangle(1.0 - phase)).abs() < 1e-6, "at {phase}");
		}
	}

	/// A crest peaks where the front is and reaches zero outside its width.
	#[test]
	fn a_crest_peaks_at_the_front_and_is_dark_outside_its_width() {
		assert!((crest(0.0, 0.25) - 1.0).abs() < 1e-6);
		assert_eq!(crest(0.5, 0.25), 0.0);
		assert!(crest(0.1, 0.25) > 0.0 && crest(0.1, 0.25) < 1.0);
	}

	/// A crest is bounded on both sides for every width, including widths a
	/// caller could compute as zero or wider than the period.
	#[test]
	fn a_crest_stays_in_range_for_every_width() {
		for width in [0.0, 0.05, 0.5, 1.0, 4.0] {
			for step in 0..100 {
				let value = crest(step as f32 / 100.0, width);
				assert!((0.0..=1.0).contains(&value), "width {width} at {step} produced {value}");
			}
		}
	}

	/// `between` maps the endpoints exactly and clamps beyond them, so a floor
	/// is a floor even when a caller hands it an out-of-range ramp.
	#[test]
	fn between_maps_endpoints_and_clamps_past_them() {
		assert_eq!(between(0.2, 1.0, 0.0), 0.2);
		assert_eq!(between(0.2, 1.0, 1.0), 1.0);
		assert_eq!(between(0.2, 1.0, -3.0), 0.2);
		assert_eq!(between(0.2, 1.0, 3.0), 1.0);
	}
}
