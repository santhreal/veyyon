//! WHY THIS SUITE EXISTS. The window opened at a fixed size centred on the
//! primary display, so on any display smaller than that size it hung off every
//! edge at once. What goes off the bottom edge is the composer, which is the
//! control the window exists for: the app looked like it had no way to write a
//! message. A laptop panel shorter than the asked-for height, a virtual display
//! on a capture host, and a scaled 4K panel are all that case.
//!
//! It fixes the class rather than the one size: the opening size is a function
//! of the room the display has, checked at both ends and at the boundary where
//! the two rules meet.
//!
//! WHAT IT DOES NOT CATCH. Whether the platform honours the bounds it is given,
//! whether a window manager then resizes the window, and whether a display
//! reports a work area smaller than its bounds (a taskbar, a dock, a panel).
//! The margin is what covers the last case, and nothing here proves the margin
//! is large enough for a particular desktop.

use gpui::{Pixels, px, size};
use veyyon_gui_kit::theme::layout;

use super::{HEIGHT, MARGIN, MIN_HEIGHT, MIN_WIDTH, WIDTH, fitted};

/// The size the window asks for, which is what it should get on a display with
/// the room for it.
fn asked() -> gpui::Size<Pixels> {
	size(px(WIDTH), px(HEIGHT))
}

#[test]
fn a_display_with_room_gets_the_size_the_window_asked_for() {
	let room = size(px(WIDTH + MARGIN + 100.0), px(HEIGHT + MARGIN + 100.0));
	assert_eq!(fitted(Some(room)), asked());
}

#[test]
fn a_display_exactly_the_asked_size_still_leaves_its_margin() {
	// The boundary: a 1320x880 panel has no room for a 1320x880 window plus the
	// margin, so both axes shrink by exactly the margin rather than staying and
	// touching all four edges.
	let room = asked();
	let opened = fitted(Some(room));
	assert_eq!(opened.width, px(WIDTH - MARGIN));
	assert_eq!(opened.height, px(HEIGHT - MARGIN));
}

#[test]
fn a_display_smaller_than_the_window_shrinks_it_to_fit_with_its_margin() {
	let room = size(px(1_000.0), px(760.0));
	let opened = fitted(Some(room));

	assert_eq!(opened.width, px(1_000.0 - MARGIN));
	assert_eq!(opened.height, px(760.0 - MARGIN));
	assert!(
		opened.width < room.width && opened.height < room.height,
		"the window opened larger than the display it opened on"
	);
}

#[test]
fn one_short_axis_shrinks_alone() {
	// A wide, short panel: the height is the only axis with a problem, and the
	// width is not paid for it.
	let room = size(px(3_440.0), px(768.0));
	let opened = fitted(Some(room));

	assert_eq!(opened.width, px(WIDTH));
	assert_eq!(opened.height, px(768.0 - MARGIN));
}

#[test]
fn a_display_smaller_than_the_minimum_stops_at_the_minimum() {
	// Below the size the window can lay out, shrinking stops: an unusable
	// window that fits is worse than one the operator can move, and the
	// platform refuses a smaller size anyway.
	let opened = fitted(Some(size(px(400.0), px(300.0))));

	assert_eq!(opened.width, px(MIN_WIDTH));
	assert_eq!(opened.height, px(MIN_HEIGHT));
}

#[test]
fn no_display_at_all_asks_for_the_full_size() {
	// Headless, or a platform that reports no display: the asked-for size is
	// the only information there is, and the platform clamps it.
	assert_eq!(fitted(None), asked());
}

#[test]
fn every_display_between_the_two_rules_gets_a_size_that_fits_and_is_usable() {
	// The sweep across the boundary, so a comparison written the wrong way
	// round cannot hide between the cases above: for every display from smaller
	// than the minimum to larger than the asked size, the window is at least
	// the minimum, never larger than asked, and fits unless the minimum forces
	// it not to.
	let mut width = 320.0;
	while width <= WIDTH + 200.0 {
		let room = size(px(width), px(width * 0.6));
		let opened = fitted(Some(room));

		assert!(opened.width >= px(MIN_WIDTH), "{width}: narrower than the window's floor");
		assert!(opened.width <= px(WIDTH), "{width}: wider than the window asked for");
		assert!(
			opened.width <= room.width || opened.width == px(MIN_WIDTH),
			"{width}: wider than the display for a reason other than the floor"
		);
		width += 37.0;
	}
}

#[test]
fn every_display_the_layout_is_drawn_for_gets_a_window_that_fits_inside_it() {
	// The layout states the smallest window it is drawn for, and the window had
	// a second copy of that floor eighty pixels wider. A display exactly the
	// layout's own minimum — which is the size every narrow capture records at
	// — therefore opened a window wider than itself, with its right edge and
	// the controls on it off the screen, while the app lays that width out
	// correctly. The sweep covers every display from the floor up, on both
	// axes, so a floor that drifts away from the layout's again is caught
	// wherever it drifts.
	let mut width = layout::MIN_WINDOW_WIDTH;
	while width <= WIDTH + MARGIN {
		let mut height = layout::MIN_WINDOW_HEIGHT;
		while height <= HEIGHT + MARGIN {
			let room = size(px(width), px(height));
			let opened = fitted(Some(room));

			assert!(
				opened.width <= room.width,
				"{width}x{height}: the window opened wider than the display"
			);
			assert!(
				opened.height <= room.height,
				"{width}x{height}: the window opened taller than the display"
			);
			height += 53.0;
		}
		width += 47.0;
	}
}
