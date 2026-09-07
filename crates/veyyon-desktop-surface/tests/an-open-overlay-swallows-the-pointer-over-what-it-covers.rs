//! WHY THIS SUITE EXISTS:
//! The modal scrim drew over the whole window and painted a hitbox, but it did
//! not block the pointer, so a press over it ran the listeners of everything
//! underneath as well. A queue card behind an open dialog still selected its
//! session, and a press inside the dialog was followed in the same bubble pass
//! by a background element taking the focus back, which is why a settings row
//! field could be clicked and still not hold the caret.
//!
//! THE CLASS THIS CLOSES:
//! A pointer press over an open overlay reaching a control the overlay covers,
//! for every `Overlay` variant. The sweep matches the variant exhaustively, so
//! a new overlay kind fails to compile here until its answer is recorded. Each
//! case carries its own positive control: the same press with no overlay open
//! raises the background intent, so a case that stops raising it because the
//! fixture drifted fails instead of passing vacuously.
//!
//! WHAT IT DOES NOT CATCH:
//! Each modal case presses one point over one background control (a queue
//! card, which is outside every dialog's own rect and therefore on the scrim),
//! and the anchored composer popover is covered at its search field alone. It
//! does not cover keyboard routing while an overlay is open, which the palette
//! and settings key suites own.

#[path = "support/large_queue.rs"]
mod large_queue;
#[path = "support/queue-actions/mod.rs"]
mod queue_actions;
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
#[path = "support/queue-scroll/mod.rs"]
mod queue_scroll;

use large_queue::make_large_queue_state;
use queue_actions::{QueueMetrics, center_of, find_queue_rows, make_per_section_state};
use queue_scroll::open_session;
use veyyon_desktop_model::SettingsView;
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{
	Intent, Overlay, ShellState, palette::PaletteState, settings::SettingsState,
};
use veyyon_gpui::{Pixels, Point};

/// The window the cases open, wide enough that a centred dialog leaves the
/// queue rail uncovered by the dialog itself and covered only by the scrim.
const WIDTH: u32 = 1200;
const HEIGHT: u32 = 800;

/// Every overlay a shell can hold, built at its opening state. The match is
/// exhaustive, so a new variant fails to compile until it is swept here.
fn every_overlay() -> Vec<(&'static str, Overlay)> {
	let all = vec![
		("palette", Overlay::Palette(PaletteState::commands())),
		("settings", Overlay::Settings(Box::new(SettingsState::general(SettingsView::new())))),
	];
	for (_name, overlay) in &all {
		match overlay {
			Overlay::Palette(_) | Overlay::Settings(_) => {},
		}
	}
	all
}

/// The centre of the first queue card, which is the background control the
/// cases press.
fn first_card(state: ShellState) -> Point<Pixels> {
	let metrics = QueueMetrics::load();
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state, WIDTH, HEIGHT);
	let frame = session.frame().expect("the shell draws its first frame");
	let rows = find_queue_rows(&frame, &metrics);
	center_of(*rows.first().expect("the fixture draws a queue row"))
}

/// Presses `at` on a shell holding `overlay`, and reports what the press
/// raised together with whether an overlay is still open afterwards.
fn pressed(overlay: Option<Overlay>, at: Point<Pixels>) -> (Vec<Intent>, bool) {
	let state = ShellState { overlay, ..make_per_section_state() };
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state, WIDTH, HEIGHT);
	session.frame().expect("the shell draws its first frame");
	session.click(at).expect("the press reaches the window");
	session
		.update(|view, _window, _cx| (view.drain_intents(), view.state().overlay.is_some()))
		.expect("the view is read after the press")
}

#[test]
fn a_press_over_an_open_overlay_reaches_nothing_it_covers() {
	let at = first_card(make_per_section_state());

	// The positive control: with no overlay open the same press selects the
	// session whose card it landed on.
	let (raised, _) = pressed(None, at);
	assert!(
		raised.contains(&Intent::SelectSession(101)),
		"with no overlay open a press on a queue card selects its session"
	);

	for (name, overlay) in every_overlay() {
		let (raised, still_open) = pressed(Some(overlay), at);
		assert!(
			!raised
				.iter()
				.any(|intent| matches!(intent, Intent::SelectSession(_))),
			"a press over the open {name} overlay selects no session behind it"
		);
		assert!(
			!still_open,
			"the {name} overlay takes the press itself and closes, rather than passing it through"
		);
	}
}

/// The vertical origin of the first row the rail draws after turning the
/// wheel by `lines` over the rail, with `overlay` open.
fn rail_after_wheel(overlay: Option<Overlay>, lines: f32) -> Pixels {
	let metrics = QueueMetrics::load();
	let state = ShellState { overlay, ..make_large_queue_state() };
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state, WIDTH, HEIGHT);
	let frame = session.frame().expect("the shell draws its first frame");
	let at = center_of(
		*find_queue_rows(&frame, &metrics)
			.first()
			.expect("the fixture draws a queue row"),
	);
	session
		.scroll(at, lines)
		.expect("the wheel reaches the window");
	let frame = session.frame().expect("the shell redraws after the wheel");
	find_queue_rows(&frame, &metrics)
		.first()
		.expect("the rail still draws rows after the wheel")
		.origin
		.y
}

#[test]
fn a_wheel_over_an_open_overlay_does_not_scroll_what_it_covers() {
	let resting = rail_after_wheel(None, 0.0);

	// The positive control: with no overlay open the same wheel moves the rail
	// under the pointer.
	assert_ne!(
		rail_after_wheel(None, 6.0),
		resting,
		"with no overlay open a wheel over the rail scrolls it"
	);

	for (name, overlay) in every_overlay() {
		assert_eq!(
			rail_after_wheel(Some(overlay), 6.0),
			resting,
			"a wheel over the open {name} overlay leaves the rail behind it where it was"
		);
	}
}

#[test]
fn a_press_in_the_anchored_palette_stays_in_the_palette() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, make_large_queue_state(), WIDTH, HEIGHT);
	session.frame().expect("the shell draws its first frame");
	// The model catalogue is the palette anchored to the composer rather than
	// centred behind a scrim, so it is the one overlay the scrim never covers.
	let editor = session
		.update(|view, window, cx| {
			view.open_model_picker(window, cx);
			view.palette_editor()
		})
		.expect("the view opens the anchored palette")
		.expect("the anchored palette draws a search field");
	session.frame().expect("the anchored palette draws a frame");
	let at = session
		.update(|_view, _window, cx| {
			editor
				.read(cx)
				.drawn_bounds()
				.expect("the palette's field drew a rect a pointer can reach")
		})
		.expect("the field's rect is read out of the editor")
		.center();
	session.click(at).expect("the press reaches the window");
	let (focused, raised) = session
		.update(|view, window, cx| {
			(editor.read(cx).focus_handle().is_focused(window), view.drain_intents())
		})
		.expect("the view is read after the press");
	assert!(focused, "a press in the anchored palette's field leaves the caret in that field");
	assert_eq!(
		raised,
		Vec::new(),
		"a press in the anchored palette's field reaches nothing behind the palette"
	);
}
