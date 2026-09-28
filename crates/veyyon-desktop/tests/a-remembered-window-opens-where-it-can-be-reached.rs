//! WHY: §8.10 remembers a window's geometry, and it comes back on a machine
//! that has since changed. A rect left on a monitor that is now unplugged
//! reopens the window where no pointer reaches it.
//!
//! The class this closes is a remembered geometry applied without asking
//! whether it still fits: a display that is gone, no display at all, a size
//! below what the window can draw at, and the maximised flag. Each case is
//! driven through `placement`, the function the binary calls, so a window that
//! cannot be reached fails here rather than on the operator's desk.
//!
//! What it does not catch: whether the platform honours the bounds it is
//! given, which is the window manager's.

use veyyon_desktop::state::placement;
use veyyon_desktop_model::PersistedState;
use veyyon_gpui::{Bounds, Pixels, Point, Size, px};

/// A floor below every remembered size these cases use.
const MIN_WIDTH: f32 = 800.0;
const MIN_HEIGHT: f32 = 560.0;

/// One display, at the origin, 1920 by 1080.
const fn primary() -> Bounds<Pixels> {
	Bounds {
		origin: Point { x: px(0.0), y: px(0.0) },
		size:   Size { width: px(1920.0), height: px(1080.0) },
	}
}

/// A state remembering a window at `x`, `y` of `width` by `height`.
fn remembered(x: i32, y: i32, width: u32, height: u32) -> PersistedState {
	let mut state = PersistedState::new();
	state.window.x = x;
	state.window.y = y;
	state.window.width = width;
	state.window.height = height;
	state
}

#[test]
fn a_window_on_a_display_this_machine_still_has_opens_where_it_was() {
	let state = remembered(220, 140, 1480, 920);
	let (bounds, maximized) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert!(!maximized);
	assert_eq!(f32::from(bounds.origin.x), 220.0);
	assert_eq!(f32::from(bounds.origin.y), 140.0);
	assert_eq!(f32::from(bounds.size.width), 1480.0);
	assert_eq!(f32::from(bounds.size.height), 920.0);
}

#[test]
fn a_window_off_every_display_comes_back_centred_on_one_that_exists() {
	// The rect a second monitor to the right left behind, after it was
	// unplugged.
	let state = remembered(3200, 400, 1480, 920);
	let (bounds, _) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert!(
		primary().contains(&bounds.center()),
		"the window opens on a display that exists: {bounds:?}"
	);
	assert_eq!(
		f32::from(bounds.size.width),
		1480.0,
		"the remembered size is kept; only the place it was is gone"
	);
	assert_eq!(f32::from(bounds.size.height), 920.0);
}

#[test]
fn a_window_the_platform_reports_no_display_for_still_opens() {
	let state = remembered(3200, 400, 1480, 920);
	let (bounds, _) = placement(&state, &[], MIN_WIDTH, MIN_HEIGHT);
	assert_eq!(f32::from(bounds.origin.x), 0.0);
	assert_eq!(f32::from(bounds.origin.y), 0.0);
	assert_eq!(f32::from(bounds.size.width), 1480.0);
}

#[test]
fn a_remembered_size_under_the_floor_opens_at_the_floor() {
	let state = remembered(10, 10, 320, 240);
	let (bounds, _) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert_eq!(
		f32::from(bounds.size.width),
		MIN_WIDTH,
		"a size below what the window draws at is raised to it"
	);
	assert_eq!(f32::from(bounds.size.height), MIN_HEIGHT);
}

#[test]
fn a_window_left_maximised_comes_back_maximised() {
	let mut state = remembered(220, 140, 1480, 920);
	state.window.maximized = true;
	let (bounds, maximized) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert!(maximized);
	assert_eq!(
		f32::from(bounds.size.width),
		1480.0,
		"the bounds it returns to when unmaximised are the ones it had"
	);
}
