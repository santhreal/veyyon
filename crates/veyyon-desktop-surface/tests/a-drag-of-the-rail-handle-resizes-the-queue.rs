//! WHY: §5.1 makes the session rail a resizable column and §7.1 gives the
//! drag the `panel` motion role, so the rail is the first pane of the kit's
//! `Resizable` and the grip at its edge is what the pointer catches. Four
//! hand-offs, each of which can be present and inert: a handle with no hit
//! area, a ratio nobody stores, a stored width the shed never reads, and a
//! bound applied to the row's declared width rather than to the dragged one.
//! The rail carried a handle that answered the press and no move, so a drag
//! set the width once at the press and then stood still.
//!
//! CLASS CLOSED: a drag of the rail handle that does not move the rail's
//! trailing edge in the next frame, a drag that moves it past either bound,
//! and a drag that moves it by something other than the pointer's travel —
//! an edge that jumps to the pointer on the first move (the press lands
//! mid-grip, so that jump is half the grip and outside the 1px tolerance), or
//! a move measured from the frame drawn after the previous move rather than
//! from the press, which `HeadlessSession::drag` would expose because it
//! delivers a frame after each move. Every arm is driven through the frame's
//! own pointer path and asserted on the laid-out box the rail is recorded in,
//! not on a field.
//!
//! NOT CAUGHT: the drag's feel — the cursor and the spring on release — and a
//! window narrow enough that the row floats the rail instead of docking it,
//! where there is no split to drag.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ShellView,
	damage::Region,
	fixture, install_tokens,
	layout::{LabelState, ShedInput, shell_widths},
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point, px};

const WIDTH: f32 = 1440.0;
const HEIGHT: f32 = 900.0;

fn options() -> RenderOptions {
	RenderOptions {
		width: WIDTH as u32,
		height: HEIGHT as u32,
		scale_factor: 1.0,
		..RenderOptions::default()
	}
}

/// The shed for the populated window, with a dragged rail width when one is
/// set.
fn shed(queue_width: Option<f32>) -> ShedInput {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	ShedInput {
		viewport_px: WIDTH,
		viewport_height_px: HEIGHT,
		chrome_height_px: tokens.surface.shell.titlebar_height_px,
		gutter_px: 8.0,
		queue_collapsed: false,
		queue_float_open: false,
		queue_width,
		panel_open: true,
		panel_width: None,
		labels: LabelState::default(),
	}
}

/// The rail width the shed resolves for `queue_width`.
fn rail_width(queue_width: Option<f32>) -> f32 {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let width = shell_widths(shed(queue_width), &tokens.surface)
		.queue
		.inline_width();
	assert!(width > 0.0, "a {WIDTH}px window docks the rail beside the transcript");
	width
}

/// The box the last frame recorded the rail in.
fn rail_box(session: &mut HeadlessSession<'_, ShellView>) -> Bounds<Pixels> {
	session
		.update(|view, _window, _cx| view.laid_out().bounds(Region::Queue))
		.expect("the view is live")
		.expect("the frame recorded the rail's box")
}

/// Drags the handle at the rail's trailing edge by `dx` and reports the rail's
/// recorded width before and after, with the width the drag stored.
fn drag_handle_by(dx: f32) -> (f32, f32, Option<f32>) {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let mut session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("the session opens");
	session.frame().expect("the first frame renders");
	let before = rail_box(&mut session);
	// The grip the pointer has to catch is the one the queue tokens author,
	// and it is drawn inside the width the shed resolved: the rail ends where
	// its declared width does, and the grip is the last of it.
	let grip = session
		.update(|view, _window, _cx| view.installed().surface.queue.width_resize_handle_hit_px)
		.expect("the view is live");
	let edge = rail_width(None) - grip;
	let handle = Point::new(px(edge + grip / 2.0), px(HEIGHT / 2.0));
	session
		.drag(handle, Point::new(px(edge + grip / 2.0 + dx), px(HEIGHT / 2.0)))
		.expect("the drag dispatches");
	session.frame().expect("the frame after the drag renders");
	let after = rail_box(&mut session);
	let stored = session
		.update(|view, _window, _cx| view.queue_width())
		.expect("the view is live");
	(f32::from(before.size.width), f32::from(after.size.width), stored)
}

#[test]
fn dragging_the_handle_outward_widens_the_rail_by_the_distance_dragged() {
	let dx = 64.0;
	let (before, after, stored) = drag_handle_by(dx);
	let stored = stored.expect("the drag stored no width on the view");

	assert!(
		(stored - (rail_width(None) + dx)).abs() <= 1.0,
		"the drag asked for {stored}px; the handle moved {dx}px from a {}px rail",
		rail_width(None)
	);
	assert!(
		((after - before) - dx).abs() <= 1.0,
		"the rail's box went from {before}px to {after}px, not by the {dx}px dragged"
	);
	assert!(
		(rail_width(Some(stored)) - stored).abs() <= 1.0,
		"the shed resolved {}px for a rail the drag stored {stored}px for",
		rail_width(Some(stored))
	);
}

#[test]
fn dragging_the_handle_inward_stops_at_the_rail_minimum() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let floor = tokens.surface.queue.width_min_px;
	let (before, after, stored) = drag_handle_by(-(rail_width(None) - 16.0));
	let stored = stored.expect("the drag stored no width on the view");

	assert!(
		16.0 < floor && (stored - floor).abs() <= 1.0,
		"a pointer drag below the minimum stored {stored}px instead of the {floor}px floor"
	);
	assert_eq!(
		rail_width(Some(stored)),
		floor,
		"a drag below the rail's minimum resolved past it instead of stopping at the floor"
	);
	let moved = before - after;
	assert!(
		(moved - (rail_width(None) - floor)).abs() <= 1.0,
		"the rail's box narrowed {moved}px, not the {}px to its floor",
		rail_width(None) - floor
	);
}

#[test]
fn dragging_the_handle_past_the_bound_stops_at_the_bound() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let queue = &tokens.surface.queue;
	// The rail stops short of the width that would leave the transcript
	// nothing; the floor keeps that bound above the rail's own minimum.
	let bound = (WIDTH - queue.width_max_viewport_delta_px)
		.max(queue.width_floor_max_px)
		.max(queue.width_min_px);
	let (before, after, stored) = drag_handle_by(WIDTH / 2.0);
	let stored = stored.expect("the drag stored no width on the view");

	assert!(
		rail_width(None) + WIDTH / 2.0 > bound && (stored - bound).abs() <= 1.0,
		"an out-of-bounds pointer drag stored {stored}px instead of the {bound}px bound"
	);
	let bounded = rail_width(Some(stored));
	assert!(
		(bounded - bound).abs() <= 1.0,
		"a drag past the bound resolved to {bounded}px rather than the {bound}px bound"
	);
	let moved = after - before;
	assert!(
		(moved - (bound - rail_width(None))).abs() <= 1.0,
		"the rail's box widened {moved}px, not the {}px to its bound",
		bound - rail_width(None)
	);
}
