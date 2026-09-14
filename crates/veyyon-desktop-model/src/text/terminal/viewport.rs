//! How many cells a box has room for.
//!
//! A terminal's size is not a constant: it is whatever the window gives the
//! grid, divided by one cell. The arithmetic is here rather than beside the
//! renderer because it is what the emulator is resized to and what the host
//! is told, and both of those have to agree with the frame without a window
//! to ask.

/// The widest grid a measured box is allowed to produce.
///
/// A box arrives from a frame, and a frame can report an absurd one while a
/// window is being resized or before anything has been laid out. The bound is
/// far past any terminal an operator reads and keeps one bad measure from
/// allocating a grid nothing can draw.
pub const MAX_COLUMNS: u16 = 1_000;

/// The tallest grid a measured box is allowed to produce.
pub const MAX_ROWS: u16 = 500;

/// The columns and rows of `cell_width_px` by `cell_height_px` cells that fit
/// in a box of `width_px` by `height_px`, never below `floor`.
///
/// A measure that is not a number, or a cell with no size, leaves the floor:
/// the grid the window already holds is a better answer than a grid of one
/// column.
#[must_use]
pub fn cells_that_fit(
	width_px: f32,
	height_px: f32,
	cell_width_px: f32,
	cell_height_px: f32,
	floor: (u16, u16),
) -> (u16, u16) {
	(
		fit(width_px, cell_width_px, floor.0, MAX_COLUMNS),
		fit(height_px, cell_height_px, floor.1, MAX_ROWS),
	)
}

/// How many `cell_px` steps fit in `extent_px`, held between `floor` and
/// `ceiling`.
fn fit(extent_px: f32, cell_px: f32, floor: u16, ceiling: u16) -> u16 {
	if !extent_px.is_finite() || !cell_px.is_finite() || cell_px <= 0.0 || extent_px <= 0.0 {
		return floor.min(ceiling);
	}
	let counted = (extent_px / cell_px).floor();
	let counted = if counted >= f32::from(ceiling) {
		ceiling
	} else {
		// The value is below a u16 ceiling and at least zero, so the cast
		// cannot wrap or saturate.
		#[expect(
			clippy::cast_possible_truncation,
			clippy::cast_sign_loss,
			reason = "the value is below a u16 ceiling and at least zero"
		)]
		let counted = counted.max(0.0) as u16;
		counted
	};
	counted.max(floor).min(ceiling)
}
