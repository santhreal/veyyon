//! WHY: a native capture of the queue badge abandoned six takes in a row at
//! `model-picker-open`. The chord that opens the model catalogue moved 1/1000
//! of the window and a left click on the chip that names the model moved
//! 0/1000, so the model id typed after it went into the draft and the prompt
//! submitted after that was a turn with no model. Every one of those takes had
//! opened and dismissed an overlay first — the shared composer prelude opens
//! the slash palette and presses Escape — and the chip drew its chevron the
//! whole time, which is the shape of the worst defect this surface can ship: a
//! control that looks live and answers nothing.
//!
//! CLASS CLOSED: a dismissal that leaves the surface unable to reopen what it
//! dismissed. Every way an overlay leaves the screen is swept from the route
//! table rather than listed here, and each is followed by both hands — a real
//! `MouseDown`/`MouseUp` pair on the chip's own hit rect, and the chord — so a
//! path that survives on the keyboard and dies under the pointer fails here.
//! The press is dispatched through the window, so a handler that is registered
//! on an element the frame never hit-tests, sits under an occluding hitbox, or
//! is refused by a stale availability, is caught the same way the operator
//! meets it.
//!
//! NOT CAUGHT: whether the reopened catalogue holds the rows the host sent,
//! which is `a-model-picker-states-the-account-above-the-models-it-serves.rs`,
//! and whether the chord's spelling is the one the keymap publishes, which is
//! `every-chord-in-the-table-resolves-innermost-first-and-a-duplicate-fails-to-load.rs`.

mod support;

use support::overlay_pointer::{
	Dismissal, center, dismiss, open_test_session, palette_mode, press_along_control_row,
};
use veyyon_desktop_scene::{HeadlessSession, headless::headless_context};
use veyyon_desktop_surface::{Intent, ShellView, keymap::resolve_chord, palette::PaletteMode};
use veyyon_gpui::{Bounds, Pixels, px};

#[test]
fn the_model_chip_answers_a_press_on_a_window_that_has_dismissed_nothing() {
	// The control case. Without it a failure below cannot be read: a chip that
	// answers no press on a fresh window is a wiring defect in the footer, and
	// one that answers here and not after a dismissal is the float eating the
	// pointer on its way out.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	assert!(
		press_along_control_row(&mut session).is_some(),
		"no press along the composer's row of controls opened the model catalogue on a window where \
		 nothing had been opened or dismissed, so the chip is not wired to the pointer at all"
	);
}

#[test]
fn the_model_chip_answers_a_press_after_every_way_an_overlay_is_dismissed() {
	let mut cx = headless_context().expect("a headless renderer is required");
	for how in Dismissal::ALL {
		let mut session = open_test_session(&mut cx);
		dismiss(&mut session, how);

		let reached = press_along_control_row(&mut session);
		assert!(
			reached.is_some(),
			"after {how:?} no press anywhere along the composer's row of controls opened the model \
			 catalogue, so the chip draws a chevron and answers nothing, and a model id typed after \
			 the press lands in the draft"
		);
	}
}

#[test]
fn the_model_chord_answers_after_every_way_an_overlay_is_dismissed() {
	let mut cx = headless_context().expect("a headless renderer is required");
	for how in Dismissal::ALL {
		let mut session = open_test_session(&mut cx);
		dismiss(&mut session, how);

		let handled = session
			.keystroke(&resolve_chord("primary-shift-m"))
			.expect("the model chord dispatches");
		session.frame().expect("the frame after the chord");
		assert!(
			handled,
			"after {how:?} the model chord reached no action, so the keys land in the composer and \
			 the return after them submits a model id as a prompt"
		);
		assert_eq!(
			palette_mode(&mut session),
			Some(PaletteMode::Models),
			"after {how:?} the model chord was handled by something other than the catalogue"
		);
	}
}

#[test]
fn a_press_on_the_chip_reopens_the_catalogue_it_just_dismissed_every_time() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	// One reach establishes which control in the row is the chip. Repeating the
	// press on that same rect is what an operator retrying a missed click does,
	// and it is where a dismissal that poisons the reopen shows up on the
	// second attempt rather than the first.
	dismiss(&mut session, Dismissal::SlashEscape);
	let chip = press_along_control_row(&mut session).expect("the chip answers the first press");
	assert!(
		session.keystroke("escape").expect("Escape dispatches"),
		"Escape was not handled with the catalogue open"
	);
	session.frame().expect("the frame with the catalogue shut");

	for attempt in 1..=3 {
		session
			.click(center(chip))
			.expect("the press on the chip is dispatched");
		session.frame().expect("the frame after the press");
		assert_eq!(
			palette_mode(&mut session),
			Some(PaletteMode::Models),
			"the chip stopped answering on attempt {attempt}, so a dismissal poisons the control \
			 that opened it"
		);

		assert!(
			session.keystroke("escape").expect("Escape dispatches"),
			"Escape was not handled on attempt {attempt}"
		);
		session.frame().expect("the frame after the dismissal");
		assert_eq!(
			palette_mode(&mut session),
			None,
			"Escape on attempt {attempt} left the catalogue open"
		);
	}
}

/// A queue row that opens a different session, the session that was open
/// before it was pressed, and the one it opened.
///
/// It is pressed here on a window with nothing open, so the row is known to
/// answer a press at all before the suite asks whether a press it should not
/// answer reaches it.
fn a_queue_row_that_opens_a_session(
	session: &mut HeadlessSession<'_, ShellView>,
) -> (Bounds<Pixels>, u64, u64) {
	let captured = session.frame().expect("a frame is captured");
	let before = session
		.update(|view, _, _| view.state().current_id)
		.expect("the open session is readable");
	let mut rows: Vec<Bounds<Pixels>> = captured
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| {
			// A row of the queue: against the leading edge, no wider than the
			// rail, below the rail's search field, and between a line's height
			// and a card's.
			rect.origin.x < px(32.0)
				&& rect.size.width < px(320.0)
				&& rect.origin.y > px(96.0)
				&& rect.size.height > px(24.0)
				&& rect.size.height < px(96.0)
		})
		.collect();
	rows.sort_by(|a, b| {
		a.origin
			.y
			.partial_cmp(&b.origin.y)
			.expect("a hit rect has a finite origin")
	});
	for rect in rows {
		session
			.click(center(rect))
			.expect("the press on the queue row is dispatched");
		session.frame().expect("the frame after the press");
		let after = session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable");
		if after != before {
			return (rect, before, after);
		}
	}
	panic!(
		"no press in the queue rail opened a different session, so this suite has no control \
		 outside the popover whose activation it can observe"
	);
}

#[test]
fn the_press_that_dismisses_a_popover_does_not_also_run_what_it_landed_on() {
	// The other half of the exit rule. A popover that stops occluding the
	// moment it closes would let the very press that closed it continue into
	// the row underneath, opening a session the operator never chose. The
	// dismissing press is spent; the ones after it are not.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	let (row, before, opened) = a_queue_row_that_opens_a_session(&mut session);
	// Back to the session the row was pressed from, so the press below has the
	// same row to change and the same value to change it from.
	session
		.update(|view, _, cx| view.dispatch(Intent::SelectSession(before), cx))
		.expect("the session the sweep started from reopens");
	session.frame().expect("the frame with that session open");
	assert_eq!(
		session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable"),
		before,
		"the reset did not reopen the session the row was pressed from"
	);
	assert_ne!(
		before, opened,
		"the row opens the session that is already open, so the press below cannot be seen to have \
		 activated it"
	);

	session
		.update(|view, window, cx| view.open_model_picker(window, cx))
		.expect("the catalogue opens");
	session.frame().expect("the catalogue renders");
	assert_eq!(
		palette_mode(&mut session),
		Some(PaletteMode::Models),
		"the catalogue did not open, so there is no popover for the press to dismiss"
	);

	session
		.click(center(row))
		.expect("the press outside the popover is dispatched");
	session.frame().expect("the frame after the press");

	assert_eq!(palette_mode(&mut session), None, "a press outside the popover did not dismiss it");
	assert_eq!(
		session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable"),
		before,
		"the press that dismissed the popover also opened the session under it, so one press made \
		 two decisions"
	);
}

#[test]
fn a_press_on_the_scrim_dismisses_the_dialog_and_runs_nothing_behind_it() {
	// The centred branch of the same rule. A command palette is modal: while it
	// is open the scrim answers a press anywhere outside the dialog by closing
	// it, and nothing under the scrim sees that press. The anchored branch is
	// `the_press_that_dismisses_a_popover_does_not_also_run_what_it_landed_on`;
	// the two placements are separate code paths and each needs its own case.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	let (row, before, opened) = a_queue_row_that_opens_a_session(&mut session);
	session
		.update(|view, _, cx| view.dispatch(Intent::SelectSession(before), cx))
		.expect("the session the sweep started from reopens");
	session.frame().expect("the frame with that session open");
	assert_ne!(
		before, opened,
		"the row opens the session that is already open, so the press below cannot be seen to have \
		 activated it"
	);

	assert!(
		session
			.keystroke(&resolve_chord("primary-k"))
			.expect("the command chord dispatches"),
		"the command palette chord was not handled"
	);
	session.frame().expect("the command palette renders");
	assert_eq!(
		palette_mode(&mut session),
		Some(PaletteMode::Commands),
		"the command palette did not open, so there is no scrim for the press to land on"
	);

	session
		.click(center(row))
		.expect("the press on the scrim is dispatched");
	session.frame().expect("the frame after the press");

	assert_eq!(
		palette_mode(&mut session),
		None,
		"a press on the scrim outside the dialog did not dismiss it"
	);
	assert_eq!(
		session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable"),
		before,
		"the press on the scrim reached the queue row behind it, so the dialog is not modal"
	);
}

#[test]
fn the_model_chip_answers_a_press_while_a_dismissed_slash_command_is_still_in_the_draft() {
	// The state the native prelude leaves and the sweep above steps around:
	// `dismiss` empties the draft before the reopen, so every case there
	// presses the chip on an empty field. An operator who typed a slash, read
	// the rows and pressed Escape still has the slash in front of them, and the
	// chip is the next thing they reach for.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	session
		.update(|view, _, cx| view.set_composed("/", cx))
		.expect("the draft takes a leading slash");
	session.frame().expect("the slash palette renders");
	assert_eq!(
		palette_mode(&mut session),
		Some(PaletteMode::Commands),
		"a leading slash opened no command palette, so this case dismisses nothing"
	);
	assert!(
		session.keystroke("escape").expect("Escape dispatches"),
		"Escape was not handled while the slash palette was open"
	);
	session.frame().expect("the first frame of the exit");
	assert_eq!(
		palette_mode(&mut session),
		None,
		"Escape left the slash palette open, so the press below measures a palette that never closed"
	);
	assert_eq!(
		session
			.update(|view, _, _| view.composer_text().to_owned())
			.expect("the draft is readable"),
		"/",
		"the dismissal emptied the draft, so this case no longer holds the slash it is about"
	);

	assert!(
		press_along_control_row(&mut session).is_some(),
		"no press along the composer's control row opened the model catalogue while the draft still \
		 held a dismissed slash command, so the chip is dead until the field is cleared"
	);
}
