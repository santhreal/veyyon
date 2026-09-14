//! WHY: the cell count is arithmetic on a box a frame reported, and a frame
//! reports a box before anything is laid out, while a window is being
//! dragged, and when a pane is collapsed to nothing. Dividing those by a cell
//! gives a grid of one column, a grid of two million, or a NaN cast to zero,
//! and each of them reaches the emulator and the host's pty as a real resize.
//!
//! CLASS CLOSED:
//! 1. A measure below the floor the tokens declare reaching the grid, from a
//!    box too small, a box of zero, or a negative one.
//! 2. A box big enough, or a cell small enough, to allocate a grid nothing can
//!    draw.
//! 3. A measure that is not a number -- NaN, an infinity, a cell of zero width
//!    -- resolving to anything but the size already held.
//! 4. A partial cell counted as a whole one, which draws a column past the edge
//!    of the box.
//!
//! WHAT THIS DOES NOT CATCH: what the box is, which the surface measures off
//! the frame, and what the floor should be, which the tokens declare.

use veyyon_desktop_model::text::terminal::{MAX_COLUMNS, MAX_ROWS, cells_that_fit};

/// The drawer's own cell and floor, so the cases read as the window's.
const CELL_W: f32 = 7.2;
const CELL_H: f32 = 16.0;
const FLOOR: (u16, u16) = (80, 11);

#[test]
fn a_box_holds_the_whole_cells_that_fit_in_it_and_no_partial_one() {
	assert_eq!(cells_that_fit(720.0, 160.0, CELL_W, CELL_H, (1, 1)), (100, 10));
	assert_eq!(
		cells_that_fit(727.1, 175.9, CELL_W, CELL_H, (1, 1)),
		(100, 10),
		"a box with most of another cell in it still holds a hundred"
	);
	assert_eq!(
		cells_that_fit(734.4, 176.0, CELL_W, CELL_H, (1, 1)),
		(102, 11),
		"and holds the next one as soon as the whole cell fits"
	);
}

#[test]
fn a_box_too_small_for_the_floor_leaves_the_floor() {
	for (width, height) in [(0.0, 0.0), (100.0, 40.0), (-800.0, -600.0), (576.0, 176.0)] {
		let held = cells_that_fit(width, height, CELL_W, CELL_H, FLOOR);
		assert!(
			held.0 >= FLOOR.0 && held.1 >= FLOOR.1,
			"a {width}x{height} box measured {held:?}, below the floor {FLOOR:?}"
		);
	}
}

/// An axis that is not a number leaves that axis at its floor.
///
/// The two are independent on purpose: a width a frame could not report says
/// nothing about the height it did report, and throwing the good one away
/// would shrink the grid for the length of a drag.
#[test]
fn an_axis_that_is_not_a_number_leaves_that_axis_at_its_floor() {
	for width in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, -800.0] {
		let (cols, rows) = cells_that_fit(width, 600.0, CELL_W, CELL_H, FLOOR);
		assert_eq!(cols, FLOOR.0, "a width of {width} is not a measure");
		assert_eq!(rows, 37, "and the height it was reported with still counts");
	}
	for height in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, -600.0] {
		let (cols, rows) = cells_that_fit(800.0, height, CELL_W, CELL_H, FLOOR);
		assert_eq!(rows, FLOOR.1, "a height of {height} is not a measure");
		assert_eq!(cols, 111, "and the width it was reported with still counts");
	}
}

#[test]
fn a_cell_with_no_size_leaves_the_floor_rather_than_dividing_by_it() {
	for cell_w in [0.0, -7.2, f32::NAN, f32::INFINITY] {
		let (cols, _) = cells_that_fit(1440.0, 900.0, cell_w, CELL_H, FLOOR);
		assert_eq!(cols, FLOOR.0, "a cell {cell_w} wide divides nothing");
	}
	for cell_h in [0.0, -16.0, f32::NAN, f32::INFINITY] {
		let (_, rows) = cells_that_fit(1440.0, 900.0, CELL_W, cell_h, FLOOR);
		assert_eq!(rows, FLOOR.1, "a cell {cell_h} tall divides nothing");
	}
}

#[test]
fn a_box_no_window_has_is_held_at_the_bound() {
	let held = cells_that_fit(4_000_000.0, 2_000_000.0, CELL_W, CELL_H, FLOOR);
	assert_eq!(held, (MAX_COLUMNS, MAX_ROWS), "an absurd box is held at the bound");

	let held = cells_that_fit(1440.0, 900.0, 0.000_01, 0.000_01, FLOOR);
	assert_eq!(held, (MAX_COLUMNS, MAX_ROWS), "and so is an absurdly small cell");
}

#[test]
fn the_floor_never_raises_the_grid_past_the_bound() {
	let held = cells_that_fit(1440.0, 900.0, CELL_W, CELL_H, (u16::MAX, u16::MAX));
	assert_eq!(
		held,
		(MAX_COLUMNS, MAX_ROWS),
		"a floor past the bound is held at the bound, not allocated"
	);
}
