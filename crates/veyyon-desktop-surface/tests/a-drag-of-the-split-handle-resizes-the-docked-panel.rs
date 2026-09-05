//! WHY: §5.6 makes the docked right panel a resizable column, and the split
//! it docks into is the kit's `Resizable`: the handle starts a renderer drag,
//! the container reports the ratio, the shell stores the width, and the shed
//! bounds it on the next frame. Four hand-offs, each of which can be present
//! and inert — a handle with no hit area, a ratio nobody stores, a stored
//! width the shed never reads, a bound applied to the declared width and not
//! the dragged one.
//!
//! CLASS CLOSED: a drag of the split handle that does not move the panel's
//! leading edge in the next frame, a drag that moves it past the bounds the
//! declared width obeys, and a drag that moves it by something other than
//! the pointer's travel: a handle that jumps its edge to the pointer on the
//! first move (the press lands mid-grip, so that jump is half the grip and
//! outside the 1px tolerance), or a move measured from the frame drawn
//! after the previous move instead of from the press
//! (`HeadlessSession::drag` delivers a frame after each move). All are
//! driven through the frame's own pointer path, from a press on the handle
//! the shed placed to a release, so the assertion is the laid-out box the
//! panel is recorded in, not a field.
//!
//! NOT CAUGHT: the drag's feel — the cursor, the spring on release (§7.1) —
//! and a drag on a window narrower than the standard row, where there is no
//! split to drag.

use std::path::Path;

use veyyon_desktop_kit::{Resizable, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ShellView,
	damage::Region,
	fixture, install_tokens,
	layout::{LabelState, RightPanelPlacement, ShedInput, shell_widths},
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

/// The shed for the populated window, with a dragged width when one is set.
fn shed(panel_width: Option<f32>) -> ShedInput {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	ShedInput {
		viewport_px: WIDTH,
		viewport_height_px: HEIGHT,
		chrome_height_px: tokens.surface.shell.titlebar_height_px,
		gutter_px: 8.0,
		queue_collapsed: false,
		panel_open: true,
		panel_width,
		labels: LabelState::default(),
	}
}

/// The docked width the shed resolves for `panel_width`.
fn docked_width(panel_width: Option<f32>) -> f32 {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	match shell_widths(shed(panel_width), &tokens.surface).right_panel {
		RightPanelPlacement::Inline { width_px } => width_px,
		other => panic!("a 1440px window docks the panel; the shed placed it {other:?}"),
	}
}

/// The box the last frame recorded the panel in, with the raster margin the
/// record carries on every side taken back off.
fn panel_box(session: &mut HeadlessSession<'_, ShellView>) -> Bounds<Pixels> {
	session
		.update(|view, _window, _cx| view.laid_out().bounds(Region::Panel))
		.expect("the view is live")
		.expect("the frame recorded the panel's box")
}

/// Drags the handle at the panel's current leading edge by `dx` and returns the
/// panel's left edge before and after the drag, from the recorded boxes.
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
	let before = panel_box(&mut session);
	let grip = session
		.update(|view, _window, _cx| f32::from(Resizable::handle_extent(&view.installed().set)))
		.expect("the view is live");
	let declared = docked_width(None);
	let edge = WIDTH - declared;
	let handle = Point::new(px(edge + grip / 2.0), px(HEIGHT / 2.0));
	session
		.drag(handle, Point::new(px(edge + grip / 2.0 + dx), px(HEIGHT / 2.0)))
		.expect("the drag dispatches");
	session.frame().expect("the frame after the drag renders");
	let after = panel_box(&mut session);
	let stored = session
		.update(|view, _window, _cx| view.panel_width())
		.expect("the view is live");
	(f32::from(before.origin.x), f32::from(after.origin.x), stored)
}

#[test]
fn dragging_the_handle_inward_widens_the_panel_by_the_distance_dragged() {
	let dx = -48.0;
	let (before, after, stored) = drag_handle_by(dx);
	let stored = stored.expect("the drag stored no width on the view");

	assert!(
		(stored - (docked_width(None) - dx)).abs() <= 1.0,
		"the drag asked for {stored}px; the handle moved {dx}px from a {}px panel",
		docked_width(None)
	);
	assert!(
		((after - before) - dx).abs() <= 1.0,
		"the panel's leading edge moved from {before} to {after}, not by the {dx}px dragged"
	);
	assert!(
		(docked_width(Some(stored)) - stored).abs() <= 1.0,
		"the shed re-bounded a width inside the panel's share: {stored} became {}",
		docked_width(Some(stored))
	);
}

#[test]
fn dragging_the_handle_past_the_bound_stops_at_the_bound() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	// The shed bounds a docked panel by its share of the window and by what
	// the session surface must keep; the tighter of the two is the wall.
	let queue = shell_widths(shed(None), &tokens.surface)
		.queue_px
		.expect("a 1440px window keeps the queue rail");
	let share = WIDTH * panels.right_panel_max_viewport_ratio;
	let bound = share.min(WIDTH - queue - panels.right_panel_container_margin_px);
	let (before, after, stored) = drag_handle_by(-(WIDTH / 2.0));
	let stored = stored.expect("the drag stored no width on the view");

	assert!(
		stored > bound,
		"the drag asked for {stored}px, inside the {bound}px bound, so it proves no bound"
	);
	let bounded = docked_width(Some(stored));
	assert!(
		(bounded - bound).abs() <= 1.0,
		"a drag past the bound resolved to {bounded}px rather than the {bound}px bound"
	);
	let moved = before - after;
	assert!(
		(moved - (bound - docked_width(None))).abs() <= 1.0,
		"the panel's leading edge moved {moved}px, not the {}px to its bound",
		bound - docked_width(None)
	);
}

#[test]
fn dragging_the_handle_outward_stops_at_the_panel_minimum() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let floor = tokens.surface.panels.right_panel_min_width_px;
	let (before, after, stored) = drag_handle_by(docked_width(None) - 16.0);
	let stored = stored.expect("the drag stored no width on the view");

	assert!(
		stored < floor,
		"the drag asked for {stored}px, above the {floor}px floor, so it proves no bound"
	);
	assert_eq!(
		docked_width(Some(stored)),
		floor,
		"a drag below the panel's minimum resolved past it instead of stopping at the floor"
	);
	let moved = after - before;
	assert!(
		(moved - (docked_width(None) - floor)).abs() <= 1.0,
		"the panel's leading edge moved {moved}px, not the {}px to its floor",
		docked_width(None) - floor
	);
}
