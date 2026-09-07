//! WHY: The rail is the quiet surface (§5.1, §5.2). Command destinations —
//! accounts, settings and every settings page — are reached through the command
//! surface, and exactly one of them keeps a permanent control: the settings
//! gear pinned to the rail's footer. Every other destination that grows a rail
//! shortcut turns the rail into a second navigation hierarchy, which is the
//! defect this closes, and it arrives one harmless-looking icon at a time.
//!
//! THE CLASS THIS CLOSES: a permanent rail control that reaches a command
//! destination. The destinations are read from `command_items()` at run time,
//! so a new settings page or a new `/`-command destination is swept the moment
//! it is declared rather than when someone remembers this file. The rail's
//! controls are read from the rendered frame's hitboxes, so a shortcut added
//! anywhere in the rail — header, section, row, footer — is found by clicking
//! it and seeing where it lands, not by matching an element id. The opt-out is
//! pinned by exact equality, so promoting a second destination has to be
//! written down here to pass.
//!
//! WHAT IT DOES NOT CATCH: the palette's own routing, which
//! `command-groups-share-destinations-and-preserve-navigation` drives; the
//! gear's reach across the width shed, which
//! `the-rail-footer-gear-is-reachable-at-every-width-that-draws-a-rail` owns;
//! and a destination reached from the titlebar or the composer, which are not
//! the rail.

#[path = "support/queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
mod queue_scroll;

use std::collections::BTreeSet;

use queue_scroll::open_session;
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::{Captured, headless_context};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItemKind, ShellView, fixture, navigation::SurfaceRoute,
	palette::commands::command_items,
};
use veyyon_gpui::{Bounds, Pixels, Point};

const WINDOW_W: u32 = 1280;
const WINDOW_H: u32 = 900;

/// The one destination the rail is allowed to hold a permanent control for.
const RAIL_SHORTCUTS: &[SurfaceRoute] = &[SurfaceRoute::Settings];

/// Every destination the command surface offers, read from the shipped command
/// table rather than written out here.
fn command_destinations() -> BTreeSet<String> {
	command_items()
		.into_iter()
		.filter_map(|item| match item.kind {
			PaletteItemKind::Command { intent } => match *intent {
				Intent::Navigate(route) => Some(format!("{route:?}")),
				_ => None,
			},
			_ => None,
		})
		.collect()
}

fn centre(bounds: Bounds<Pixels>) -> Point<Pixels> {
	Point {
		x: bounds.origin.x + bounds.size.width / 2.0,
		y: bounds.origin.y + bounds.size.height / 2.0,
	}
}

/// Every hitbox the rail column draws, in draw order, deduplicated by rect so
/// a control wrapped in an interactive parent is clicked once.
fn rail_controls(captured: &Captured, rail_px: f32) -> Vec<Bounds<Pixels>> {
	let mut out: Vec<Bounds<Pixels>> = Vec::new();
	for rect in &captured.hitboxes {
		let right = f32::from(rect.origin.x) + f32::from(rect.size.width);
		if right > rail_px + 1.0 {
			continue;
		}
		if !out.iter().any(|kept| kept == rect) {
			out.push(*rect);
		}
	}
	out.sort_by(|a, b| {
		(f32::from(a.origin.y), f32::from(a.origin.x))
			.partial_cmp(&(f32::from(b.origin.y), f32::from(b.origin.x)))
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	out
}

#[test]
fn every_command_destination_except_settings_has_no_permanent_rail_control() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let rail_px = tokens
		.surface
		.breakpoints
		.resolve(WINDOW_W as f32)
		.queue_width_px;
	assert!(rail_px > 0.0, "the window draws a rail at {WINDOW_W}px");

	let destinations = command_destinations();
	assert!(
		destinations.contains("Settings"),
		"the command table offers the settings destination this test is about; got {destinations:?}"
	);
	assert!(
		destinations.len() > 2,
		"the command table offers the account and page destinations too, which is what makes this \
		 a sweep; got {destinations:?}"
	);

	let mut cx = headless_context().expect("headless renderer is required");
	let control_count = {
		let mut session: veyyon_desktop_scene::HeadlessSession<'_, ShellView> =
			open_session(&mut cx, fixture::populated(), WINDOW_W, WINDOW_H);
		let frame = session.frame().expect("the shell renders at rest");
		rail_controls(&frame, rail_px).len()
	};
	assert!(
		control_count > 5,
		"the rail draws its header, its rows and its footer; got {control_count} controls"
	);

	// One window per control: a click that collapses a section or selects a
	// session changes the frame the next click would land on, and a stale rect
	// would click whatever moved into it.
	let mut reached: Vec<(usize, String)> = Vec::new();
	for index in 0..control_count {
		let mut session: veyyon_desktop_scene::HeadlessSession<'_, ShellView> =
			open_session(&mut cx, fixture::populated(), WINDOW_W, WINDOW_H);
		let frame = session.frame().expect("the shell renders at rest");
		let controls = rail_controls(&frame, rail_px);
		assert_eq!(
			controls.len(),
			control_count,
			"the rail draws the same controls on every fresh window"
		);
		let target = controls[index];
		session
			.click(centre(target))
			.expect("the click reaches the window");
		let route = session
			.update(|view, _window, _cx| {
				view.state()
					.overlay
					.as_ref()
					.and_then(Overlay::route)
					.map(|route| format!("{route:?}"))
			})
			.expect("the overlay is read after the click");
		if let Some(route) = route {
			reached.push((index, route));
		}
	}

	let opted_in: Vec<String> = RAIL_SHORTCUTS
		.iter()
		.map(|route| format!("{route:?}"))
		.collect();
	let landed: Vec<String> = reached
		.iter()
		.map(|(_, route)| route.clone())
		.filter(|route| destinations.contains(route))
		.collect();
	assert_eq!(
		landed, opted_in,
		"the rail holds one permanent control per opted-in destination and no others; the clicks \
		 that reached a destination were {reached:?}"
	);
}

#[test]
fn the_one_rail_shortcut_is_the_footer_gear_and_not_a_row_or_a_header() {
	// The count above would also pass if the gear were moved into a section
	// header or grown onto a card, which is the same defect wearing the
	// allowance. The control that reaches the destination has to be the one
	// pinned to the footer band.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let rail_px = tokens
		.surface
		.breakpoints
		.resolve(WINDOW_W as f32)
		.queue_width_px;
	let footer_h = tokens.surface.queue.footer_height_px;

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session: veyyon_desktop_scene::HeadlessSession<'_, ShellView> =
		open_session(&mut cx, fixture::populated(), WINDOW_W, WINDOW_H);
	let frame = session.frame().expect("the shell renders at rest");
	let controls = rail_controls(&frame, rail_px);
	let footer_band: Vec<Bounds<Pixels>> = controls
		.iter()
		.filter(|rect| f32::from(rect.origin.y) >= WINDOW_H as f32 - footer_h)
		.copied()
		.collect();
	assert_eq!(
		footer_band.len(),
		1,
		"the footer band holds exactly the gear; got {footer_band:?}"
	);

	session
		.click(centre(footer_band[0]))
		.expect("the click reaches the gear");
	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.state().overlay.as_ref().and_then(Overlay::route),
				Some(SurfaceRoute::Settings),
				"the footer gear is the control that reaches the settings destination"
			);
		})
		.expect("the overlay is read after the click");
}
