//! WHY: The rail's footer holds the one settings gear an operator reaches
//! without the palette, and the rail's placement changes with the window. A
//! footer clipped out of a rail that is still drawn strands the gear with
//! nothing to click; a footer drawn where no rail is leaves a control floating
//! over the session surface. At the collapsed width the rail was shed outright
//! and the control that would bring it back moved nothing, so every session
//! but the open one was unreachable from that window.
//!
//! THE CLASS THIS CLOSES: the gear's reach at every width, in every placement
//! the breakpoint table declares. The widths and the modes are read from the
//! shipped table at run time and the sweep visits each mode, so a table that
//! moves the compact rail, floats a wider one, or docks the collapsed one
//! turns this red rather than passing against numbers written here. The band
//! the gear is looked for in comes from the box the frame drew the rail in, so
//! a placement that moves the rail moves the band with it, and the gear is
//! found by that band rather than by an id: a footer that draws its control
//! somewhere else is a failure and not a miss. The float's own box is measured
//! against the transcript's and the composer's, because a float confined to
//! the transcript clips the footer this file is about; and both routes out of
//! it -- Escape and a press outside it -- are driven, since a float that
//! leaves its controls behind hides them over the transcript instead.
//!
//! WHAT IT DOES NOT CATCH: the palette route into settings, which
//! `the-queue-scrolls-and-pages-large-lists-preserving-selection` drives with
//! the rest of the rail's navigation, and the settings surface itself. It says
//! nothing about what the float looks like, which is
//! `proof/scenes/desktop-queue-float.sh`.

#[path = "support/queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
mod queue_scroll;

use std::collections::BTreeMap;

use queue_scroll::open_session;
use veyyon_desktop_kit::{Sheet, load_bundled_tokens};
use veyyon_desktop_scene::{HeadlessSession, headless::headless_context};
use veyyon_desktop_surface::{
	Overlay, ShellView, damage::Region, fixture, keymap::resolve_chord, navigation::SurfaceRoute,
};
use veyyon_desktop_tokens::{QueueMode, SurfaceTokens};
use veyyon_gpui::{Bounds, Pixels, Point};

/// The rail's own frame in a placement: what a sheet draws around its body,
/// and nothing at all for a docked column.
fn placement_frame(session: &mut HeadlessSession<'_, ShellView>, floats: bool) -> f32 {
	if floats {
		session
			.update(|view, _window, _cx| f32::from(Sheet::inset(&view.installed().set)))
			.expect("the installed token set is read")
	} else {
		0.0
	}
}

/// The controls a fresh frame draws in the rail's footer band.
///
/// The band is the bottom `footer_h` of the rail's body, and the body is the
/// box the frame drew the rail in less the frame that placement draws around
/// it. Returns `None` when no rail was drawn at all, which is a state of its
/// own rather than an empty band.
fn rail_footer_controls(
	session: &mut HeadlessSession<'_, ShellView>,
	frame_px: f32,
	footer_h: f32,
) -> Option<Vec<Bounds<Pixels>>> {
	let hitboxes = session.frame().expect("the shell renders a frame").hitboxes;
	let rail = session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::Queue))
		.expect("the view is live");
	let rail = rail?;
	let left = f32::from(rail.origin.x) + frame_px;
	let right = f32::from(rail.origin.x + rail.size.width) - frame_px;
	let bottom = f32::from(rail.origin.y + rail.size.height) - frame_px;

	Some(
		hitboxes
			.into_iter()
			.filter(|rect| {
				let box_left = f32::from(rect.origin.x);
				let box_right = box_left + f32::from(rect.size.width);
				box_left >= left
					&& box_right <= right
					&& f32::from(rect.origin.y) >= bottom - footer_h
					&& f32::from(rect.origin.y) <= bottom
			})
			.collect(),
	)
}

/// The width the sweep reaches each declared queue mode at.
///
/// Narrow to wide, so each mode is recorded at the narrowest width that
/// declares it: the width where a rail has least room to draw its footer.
fn width_per_queue_mode(surface: &SurfaceTokens) -> BTreeMap<String, f32> {
	let mut found: BTreeMap<String, f32> = BTreeMap::new();
	for width in (320..=2400).step_by(4).map(|w| w as f32) {
		let row = surface.breakpoints.resolve(width);
		if row.queue_width_px <= 0.0 || width < surface.shell.window_min_width_px {
			continue;
		}
		found.entry(row.queue_mode.to_string()).or_insert(width);
	}
	found
}

#[test]
fn the_footer_gear_opens_settings_in_every_placement_the_table_declares() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let footer_h = tokens.surface.queue.footer_height_px;
	let height = tokens.surface.shell.window_min_height_px as u32;
	let modes = width_per_queue_mode(&tokens.surface);
	// Every mode the enum has, reached from the shipped table: a mode no width
	// declares is a placement nobody proved, and a fifth mode turns this red.
	assert_eq!(
		modes.keys().cloned().collect::<Vec<_>>(),
		vec![QueueMode::Inline.to_string(), QueueMode::Overlay.to_string()],
		"the table does not reach every declared queue mode: {modes:?}"
	);

	for (mode, width) in modes {
		let floats = mode == QueueMode::Overlay.to_string();
		let mut cx = headless_context().expect("headless renderer is required");
		let mut session = open_session(&mut cx, fixture::populated(), width as u32, height);
		session
			.frame()
			.expect("shell renders a frame at the swept width");
		let frame_px = placement_frame(&mut session, floats);

		// A docked rail is already on screen. A floated one is closed at open,
		// so there is no rail to hold a control until the operator asks: that
		// is the negative half of this assertion, and it is the state the
		// collapsed width used to be stuck in for good.
		let at_open = rail_footer_controls(&mut session, frame_px, footer_h);
		if floats {
			assert!(
				at_open.is_none(),
				"at {width}px a window that floats the rail drew one before it was asked: {at_open:?}"
			);
			session
				.update(|view, _window, cx| view.toggle_queue(cx))
				.expect("the rail control is answered");
			session.frame().expect("the frame with the float renders");
		}

		let footer = rail_footer_controls(&mut session, frame_px, footer_h)
			.unwrap_or_else(|| panic!("at {width}px in {mode} placement no rail was drawn"));
		assert_eq!(
			footer.len(),
			1,
			"at {width}px in {mode} placement the rail footer must hold exactly the settings gear; \
			 got {footer:?}"
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
					"at {width}px in {mode} placement the gear did not reach settings; the overlay is \
					 {:?}",
					view.state().overlay
				);
			})
			.expect("the overlay is read after the click");
	}
}

#[test]
fn a_floated_rail_draws_every_row_the_docked_column_would_have() {
	// The float is the only route to another session at this width, so it is
	// not an annotation of the transcript the way the right panel is: a float
	// confined to the transcript box shortens the rail by the composer band
	// and drops the rows at the bottom of a long list, footer included.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let height = tokens.surface.shell.window_min_height_px as u32;
	let width = width_per_queue_mode(&tokens.surface)
		.remove(&QueueMode::Overlay.to_string())
		.expect("the table declares a width that floats the rail");

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, fixture::populated(), width as u32, height);
	session.frame().expect("the first frame renders");
	session
		.update(|view, _window, cx| view.toggle_queue(cx))
		.expect("the rail control opens the float");
	session.frame().expect("the frame with the float renders");

	let (rail, transcript, composer) = session
		.update(|view, _window, _cx| {
			let laid_out = view.laid_out();
			(
				laid_out.drawn_bounds(Region::Queue),
				laid_out.drawn_bounds(Region::Transcript),
				laid_out.drawn_bounds(Region::Composer),
			)
		})
		.expect("the boxes of the frame are read");
	let rail = rail.expect("the float drew a rail");
	let transcript = transcript.expect("the transcript drew under the float");
	let composer = composer.expect("the composer drew under the float");
	let rail_bottom = f32::from(rail.origin.y + rail.size.height);

	assert!(
		rail_bottom > f32::from(transcript.origin.y + transcript.size.height),
		"the float stopped at the transcript ({rail_bottom}px) instead of spanning the columns row"
	);
	assert!(
		rail_bottom >= f32::from(composer.origin.y + composer.size.height),
		"the float ({rail_bottom}px) does not reach the bottom of the composer band ({}px)",
		f32::from(composer.origin.y + composer.size.height)
	);
	assert!(
		f32::from(rail.origin.y) <= f32::from(transcript.origin.y),
		"the float starts below the top of the columns row"
	);
}

#[test]
fn a_dismissed_float_leaves_no_control_where_the_rail_was() {
	// A float that closes but leaves its hitboxes behind is worse than one
	// that never opened: the controls are invisible and still clickable, over
	// the transcript.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let footer_h = tokens.surface.queue.footer_height_px;
	let height = tokens.surface.shell.window_min_height_px as u32;
	let width = width_per_queue_mode(&tokens.surface)
		.remove(&QueueMode::Overlay.to_string())
		.expect("the table declares a width that floats the rail");

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, fixture::populated(), width as u32, height);
	session.frame().expect("the first frame renders");
	let frame_px = placement_frame(&mut session, true);
	session
		.update(|view, _window, cx| view.toggle_queue(cx))
		.expect("the rail control opens the float");
	session.frame().expect("the frame with the float renders");
	assert_eq!(
		rail_footer_controls(&mut session, frame_px, footer_h).map(|found| found.len()),
		Some(1),
		"the float must open with its footer for this to mean anything"
	);

	// The Escape ladder, the rung below every overlay in `state.overlay`.
	session
		.keystroke(&resolve_chord("escape"))
		.expect("escape reaches the window");
	session.frame().expect("the frame after dismissal renders");

	// `LaidOut` keeps the last box it recorded for a region, so a dismissed
	// float still answers with one: what must be gone is the control, not the
	// memory of where it was.
	let left_behind = rail_footer_controls(&mut session, frame_px, footer_h).unwrap_or_default();
	assert!(
		left_behind.is_empty(),
		"a dismissed float left {} control(s) clickable over the transcript: {left_behind:?}",
		left_behind.len()
	);

	// The float is this window's own, so dismissing it cannot have moved the
	// standing preference that governs the widths which dock a column.
	session
		.update(|view, _window, _cx| {
			assert!(
				!view.state().keymap.queue_collapsed,
				"the float toggled the standing collapsed state, which belongs to the widths that \
				 dock a column"
			);
		})
		.expect("the collapsed state is read after dismissal");
}

#[test]
fn a_press_outside_the_float_dismisses_it_and_is_spent_on_the_dismissal() {
	// The third route out, beside the control and Escape. A press that closed
	// the float and then also answered whatever it landed on would carry out a
	// decision nobody made, in a surface the operator could not see when the
	// press started.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let footer_h = tokens.surface.queue.footer_height_px;
	let height = tokens.surface.shell.window_min_height_px as u32;
	let width = width_per_queue_mode(&tokens.surface)
		.remove(&QueueMode::Overlay.to_string())
		.expect("the table declares a width that floats the rail");

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, fixture::populated(), width as u32, height);
	session.frame().expect("the first frame renders");
	let frame_px = placement_frame(&mut session, true);
	session
		.update(|view, _window, cx| view.toggle_queue(cx))
		.expect("the rail control opens the float");
	session.frame().expect("the frame with the float renders");
	let rail = session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::Queue))
		.expect("the view is live")
		.expect("the float drew a rail");

	// A point past the rail's trailing edge and inside the row it dims: the
	// scrim, which is the only thing an operator can aim at to mean "not the
	// rail".
	session
		.click(Point {
			x: rail.origin.x + rail.size.width + Pixels::from(80.0),
			y: rail.origin.y + rail.size.height / 2.0,
		})
		.expect("the press reaches the window");
	session.frame().expect("the frame after the press renders");

	let left_behind = rail_footer_controls(&mut session, frame_px, footer_h).unwrap_or_default();
	assert!(
		left_behind.is_empty(),
		"a press outside the float left {} control(s) of it clickable: {left_behind:?}",
		left_behind.len()
	);
	session
		.update(|view, _window, _cx| {
			assert!(
				view.state().overlay.is_none(),
				"the press that dismissed the float also opened {:?} under it",
				view.state().overlay
			);
		})
		.expect("the overlay is read after the press");
}
