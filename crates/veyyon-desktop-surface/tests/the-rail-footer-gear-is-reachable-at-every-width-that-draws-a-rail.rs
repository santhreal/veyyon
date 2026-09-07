//! WHY: The rail's footer holds the one settings gear an operator reaches
//! without the palette, and the rail itself is shed at the narrowest window.
//! A footer clipped out of a rail that is still drawn strands the gear with
//! nothing to click; a footer drawn where the rail was shed leaves a control
//! floating over the session surface.
//!
//! THE CLASS THIS CLOSES: the gear's reach across the widths that change the
//! rail. Both widths are read from the shipped breakpoint table at run time,
//! so a table that moves the compact rail or stops shedding the collapsed one
//! turns this red rather than passing against numbers written here. The gear
//! is found by the band it occupies rather than by an id, so a footer that
//! draws its control somewhere else is a failure and not a miss.
//!
//! WHAT IT DOES NOT CATCH: the palette route into settings, which
//! `the-queue-scrolls-and-pages-large-lists-preserving-selection` drives with
//! the rest of the rail's navigation, and the settings surface itself.

#[path = "support/queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
mod queue_scroll;

use queue_scroll::open_session;
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{Overlay, fixture, navigation::SurfaceRoute};
use veyyon_gpui::{Bounds, Pixels, Point};

/// The band the rail's footer occupies: the bottom `footer_height_px` of the
/// window, within the rail's own column.
fn rail_footer_controls(
	hitboxes: &[Bounds<Pixels>],
	rail_px: f32,
	window_h: f32,
	footer_h: f32,
) -> Vec<Bounds<Pixels>> {
	hitboxes
		.iter()
		.filter(|rect| {
			let right = f32::from(rect.origin.x) + f32::from(rect.size.width);
			let top = f32::from(rect.origin.y);
			right <= rail_px && top >= window_h - footer_h
		})
		.copied()
		.collect()
}

#[test]
fn the_rail_footer_gear_opens_settings_at_the_narrowest_width_that_draws_a_rail() {
	// The compact breakpoint draws the rail at its narrowest measure; below it
	// the rail sheds entirely, so this is the width where a clipped footer
	// would strand the gear with nothing to click.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let compact = 980.0;
	let rail_px = tokens.surface.breakpoints.resolve(compact).queue_width_px;
	assert!(rail_px > 0.0, "the compact breakpoint draws a rail: {rail_px}");
	let footer_h = tokens.surface.queue.footer_height_px;

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, fixture::populated(), 980, 560);
	let frame = session
		.frame()
		.expect("shell renders a frame at the compact width");
	let footer = rail_footer_controls(&frame.hitboxes, rail_px, 560.0, footer_h);
	assert_eq!(
		footer.len(),
		1,
		"the rail footer holds exactly the settings gear at the compact width; got {footer:?}"
	);
	let gear = footer[0];

	session
		.click(Point {
			x: gear.origin.x + gear.size.width / 2.0,
			y: gear.origin.y + gear.size.height / 2.0,
		})
		.expect("the click reaches the window");
	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.state().overlay.as_ref().and_then(Overlay::route),
				Some(SurfaceRoute::Settings),
				"clicking the rail footer's gear reaches the settings surface; the overlay is {:?}",
				view.state().overlay
			);
		})
		.expect("the overlay is read after the click");
}

#[test]
fn a_shed_rail_leaves_no_control_where_its_column_was() {
	// At the collapsed breakpoint the rail is not drawn at all. A footer left
	// behind there is a control floating over the session surface, and a test
	// that goes looking for one in the leading strip matches whatever the
	// composer happens to draw at that corner.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let collapsed = 800.0;
	assert_eq!(
		tokens.surface.breakpoints.resolve(collapsed).queue_width_px,
		0.0,
		"the collapsed breakpoint sheds the rail, which is the premise of this test"
	);
	let compact_rail = tokens.surface.breakpoints.resolve(980.0).queue_width_px;
	let footer_h = tokens.surface.queue.footer_height_px;

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, fixture::populated(), 800, 560);
	let frame = session
		.frame()
		.expect("shell renders a frame at the collapsed width");
	let left_behind = rail_footer_controls(&frame.hitboxes, compact_rail, 560.0, footer_h);
	assert!(
		left_behind.is_empty(),
		"the shed rail's column holds no control at the collapsed width; got {left_behind:?}"
	);

	session
		.update(|view, _window, cx| {
			view.navigate_surface(SurfaceRoute::Settings, cx);
			assert_eq!(
				view.state().overlay.as_ref().and_then(Overlay::route),
				Some(SurfaceRoute::Settings),
				"settings stays reachable without a rail, through the route the palette takes"
			);
		})
		.expect("the settings route is taken without a rail");
}
