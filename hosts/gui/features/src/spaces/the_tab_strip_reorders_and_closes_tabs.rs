//! WHY THIS SUITE EXISTS. Pointer drag reordering on the tab strip must
//! hit-test against the strip's real laid-out tab rect boundaries rather than
//! guessing from array indices or equal-width slot assumptions. This suite
//! verifies that hit-testing resolves exact target indices across
//! variable-width tab rectangles, midpoints, and boundary limits.
//!
//! What this closes: misdirected tab drops and off-by-one tab reorder bugs.
//! What it does not catch: OS mouse coordinate scaling across fractional DPI.

#[cfg(test)]
mod tests {
	use super::super::tab_target_index;

	#[test]
	fn tab_target_index_resolves_correct_tab_by_boundary_and_midpoint() {
		// Three laid-out tabs with variable widths:
		// Tab 0: 0.0 .. 100.0 (midpoint 50.0)
		// Tab 1: 100.0 .. 250.0 (midpoint 175.0)
		// Tab 2: 250.0 .. 400.0 (midpoint 325.0)
		let rects = [(0.0, 100.0), (100.0, 250.0), (250.0, 400.0)];

		// Pointer at left of Tab 0
		assert_eq!(tab_target_index(20.0, &rects), 0);
		// Pointer at right of Tab 0
		assert_eq!(tab_target_index(80.0, &rects), 0);
		// Pointer in Tab 1 left of midpoint
		assert_eq!(tab_target_index(130.0, &rects), 1);
		// Pointer in Tab 1 right of midpoint
		assert_eq!(tab_target_index(200.0, &rects), 1);
		// Pointer in Tab 2
		assert_eq!(tab_target_index(300.0, &rects), 2);
		// Pointer past the right edge
		assert_eq!(tab_target_index(500.0, &rects), 2);
	}

	#[test]
	fn empty_tab_rects_safely_defaults_to_zero() {
		assert_eq!(tab_target_index(50.0, &[]), 0);
	}
}
