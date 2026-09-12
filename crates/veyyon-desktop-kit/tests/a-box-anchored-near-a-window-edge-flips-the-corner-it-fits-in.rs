//! WHY: an anchored popover asked for a corner it does not fit in used to be
//! slid along the window edge by the renderer, which left the card covering
//! the control that opened it. `flip_corner` picks the corner before layout,
//! from the size the caller declared.
//!
//! CLASS CLOSED: a corner chosen on one axis from the other axis's room, a
//! flip that happens when the requested direction fits anyway, and a box too
//! large for either direction flipped into an edge it overflows just as far.
//! The containment case derives no expectation from `flip_corner`: it places
//! the box with `anchored_position` and reads whether the rect is inside the
//! window, which is the property the corner exists to hold.
//!
//! NOT CAUGHT: whether the renderer honours the corner it is handed, which the
//! surface suite drives through a live window, and the margin's value, which
//! is a token.

use veyyon_desktop_kit::{AnchorCorner, anchored_position, flip_corner};
use veyyon_gpui::{Pixels, Point, Size, px};

/// A window large enough that a 384x320 card has room on both sides of the
/// middle and room on neither side of a corner.
const VIEWPORT: Size<Pixels> = Size { width: px(1400.0), height: px(900.0) };
const CARD: Size<Pixels> = Size { width: px(384.0), height: px(320.0) };
const MARGIN: Pixels = px(8.0);

/// Every corner, enumerated from the two axes it is made of rather than
/// listed: a fifth variant would not compile through `from_edges`.
fn corners() -> Vec<AnchorCorner> {
	[true, false]
		.into_iter()
		.flat_map(|right| {
			[true, false]
				.into_iter()
				.map(move |down| AnchorCorner::from_edges(right, down))
		})
		.collect()
}

const fn at(x: f32, y: f32) -> Point<Pixels> {
	Point { x: px(x), y: px(y) }
}

/// The rect a box of `CARD` takes when anchored at `corner` over `origin`.
fn placed(origin: Point<Pixels>, corner: AnchorCorner) -> (f32, f32, f32, f32) {
	let position = anchored_position(origin, CARD, corner);
	let left = f32::from(position.x);
	let top = f32::from(position.y);
	(left, top, left + f32::from(CARD.width), top + f32::from(CARD.height))
}

#[test]
fn a_box_with_room_on_both_sides_keeps_the_corner_it_was_asked_for() {
	let middle = at(600.0, 400.0);
	for requested in corners() {
		assert_eq!(
			flip_corner(requested, middle, CARD, VIEWPORT, MARGIN),
			requested,
			"{requested:?} fits at {middle:?} in both directions and was changed"
		);
	}
}

#[test]
fn a_box_that_would_cross_an_edge_flips_only_the_axis_that_would_cross_it() {
	// x=1300 leaves 100px to the right of the point and 1300 to its left;
	// y=400 leaves room in both directions. Only the horizontal axis moves.
	let near_right = at(1300.0, 400.0);
	assert_eq!(
		flip_corner(AnchorCorner::TopLeft, near_right, CARD, VIEWPORT, MARGIN),
		AnchorCorner::TopRight,
		"a card asked to grow right from 100px of room keeps growing down and grows left"
	);

	// y=850 leaves 50px below the point and 850 above it; x=600 has room both
	// ways. Only the vertical axis moves.
	let near_bottom = at(600.0, 850.0);
	assert_eq!(
		flip_corner(AnchorCorner::TopLeft, near_bottom, CARD, VIEWPORT, MARGIN),
		AnchorCorner::BottomLeft,
		"a card asked to grow down from 50px of room keeps growing right and grows up"
	);

	let corner = at(1300.0, 850.0);
	assert_eq!(
		flip_corner(AnchorCorner::TopLeft, corner, CARD, VIEWPORT, MARGIN),
		AnchorCorner::BottomRight,
		"a card in the bottom-right corner flips on both axes"
	);

	// The composer's model chip asks for BottomLeft, and near the top of the
	// window the vertical axis has to come back down.
	let near_top = at(600.0, 40.0);
	assert_eq!(
		flip_corner(AnchorCorner::BottomLeft, near_top, CARD, VIEWPORT, MARGIN),
		AnchorCorner::TopLeft,
		"a card asked to grow up from 40px of room grows down instead"
	);
}

#[test]
fn the_chosen_corner_keeps_the_box_inside_the_window_wherever_one_side_fits() {
	let margin = f32::from(MARGIN);
	let width = f32::from(VIEWPORT.width);
	let height = f32::from(VIEWPORT.height);
	for x in [10.0_f32, 200.0, 600.0, 1100.0, 1390.0] {
		for y in [10.0_f32, 120.0, 400.0, 700.0, 890.0] {
			let origin = at(x, y);
			for requested in corners() {
				let corner = flip_corner(requested, origin, CARD, VIEWPORT, MARGIN);
				let (left, top, right, bottom) = placed(origin, corner);
				let case = format!("{requested:?} at ({x}, {y}) chose {corner:?}");
				// A side fits when the box placed on it clears the margin; the
				// chosen corner must be on such a side whenever one exists.
				let fits_right = x + f32::from(CARD.width) <= width - margin;
				let fits_left = x - f32::from(CARD.width) >= margin;
				if fits_right || fits_left {
					assert!(
						left >= margin && right <= width - margin,
						"{case}: the card spans {left}..{right} in a {width}px window"
					);
				}
				let fits_below = y + f32::from(CARD.height) <= height - margin;
				let fits_above = y - f32::from(CARD.height) >= margin;
				if fits_below || fits_above {
					assert!(
						top >= margin && bottom <= height - margin,
						"{case}: the card spans {top}..{bottom} in a {height}px window"
					);
				}
			}
		}
	}
}

#[test]
fn a_box_too_large_for_either_direction_keeps_the_corner_it_was_given() {
	// A card wider and taller than the window fits on neither side of any
	// point, so there is nothing to flip to and the renderer's slide is what
	// brings it in.
	let oversized = Size { width: px(1600.0), height: px(1000.0) };
	let origin = at(700.0, 450.0);
	for requested in corners() {
		assert_eq!(
			flip_corner(requested, origin, oversized, VIEWPORT, MARGIN),
			requested,
			"{requested:?} has no side to flip to and was changed anyway"
		);
	}
}

/// Whether the rect a box of `size` takes at `corner` is inside the window
/// margin on both axes, read off `anchored_position` rather than off the room
/// arithmetic `flip_corner` decides from.
fn inside(origin: Point<Pixels>, size: Size<Pixels>, corner: AnchorCorner) -> bool {
	let position = anchored_position(origin, size, corner);
	let margin = f32::from(MARGIN);
	let left = f32::from(position.x);
	let top = f32::from(position.y);
	left >= margin
		&& top >= margin
		&& left + f32::from(size.width) <= f32::from(VIEWPORT.width) - margin
		&& top + f32::from(size.height) <= f32::from(VIEWPORT.height) - margin
}

/// The corner the flip chooses holds the whole rect inside the margin, at
/// every point of the grid and from every corner asked for -- which is what
/// leaves the renderer's slide with nothing to move. The one case it cannot
/// answer is a box larger than the window, which no corner contains and the
/// slide is the backstop for.
#[test]
fn every_corner_the_flip_chooses_holds_the_box_inside_the_window_margin() {
	for x in [10.0_f32, 200.0, 600.0, 1100.0, 1390.0] {
		for y in [10.0_f32, 120.0, 400.0, 700.0, 890.0] {
			let origin = at(x, y);
			for requested in corners() {
				let corner = flip_corner(requested, origin, CARD, VIEWPORT, MARGIN);
				assert!(
					inside(origin, CARD, corner),
					"{requested:?} at ({x}, {y}) chose {corner:?}, which leaves the card crossing the \
					 margin"
				);
			}
		}
	}

	let oversized = Size { width: px(1600.0), height: px(1000.0) };
	let origin = at(700.0, 450.0);
	for requested in corners() {
		let corner = flip_corner(requested, origin, oversized, VIEWPORT, MARGIN);
		assert!(
			!inside(origin, oversized, corner),
			"{requested:?} has no side that fits, so the slide is what brings it in"
		);
	}
}
