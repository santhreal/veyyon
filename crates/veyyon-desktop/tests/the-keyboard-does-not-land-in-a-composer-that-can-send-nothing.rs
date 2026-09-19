//! WHY: with no session open, `actions_for` turns `Intent::Send` into no host
//! action at all, and `project_controls` marks every composer control
//! `Unavailable { reason: NO_SESSION_OPEN }`. The window nevertheless focused
//! the composer editor on the first frame, so first run drew a composer ringed
//! in the focus accent, inviting a prompt whose send was dead and whose model
//! selector was dead. The frame said "type here" and the press did nothing.
//!
//! THE CLASS THIS CLOSES: the shell putting the keyboard in a surface the
//! projection has held back. The invariant is read off the projection at run
//! time rather than from a list written here -- while ANY control carries the
//! no-session reason, the composer does not hold focus -- so a control added
//! to `composer_controls` is covered by what it is, and a later change that
//! opens the gates without opening a session still has to satisfy it. The
//! converse case pins the other direction, so suppressing focus outright
//! fails too.
//!
//! WHAT IT DOES NOT CATCH: where focus goes instead, which is the shell's own
//! handle and carries no control of its own; and the pixels of the resting
//! border, which `whole-window/first-run` shows and the token contrast suites
//! measure. It says nothing about focus after the operator has moved it: the
//! rule is about the frame the window opens with, which is the one that made
//! the false invitation.

mod support;

use support::fields::driven;
use veyyon_desktop::{NO_SESSION_OPEN, scene::build};
use veyyon_desktop_surface::Availability;

/// Every control the projection held back for want of a session, in the order
/// the ids sort. Read off the state rather than listed here.
fn held_for_no_session(state: &veyyon_desktop_surface::ShellState) -> Vec<String> {
	state
		.controls
		.projected()
		.filter(|(_, availability)| {
			matches!(availability, Availability::Unavailable { reason } if reason == NO_SESSION_OPEN)
		})
		.map(|(id, _)| format!("{id:?}"))
		.collect()
}

#[test]
fn the_composer_does_not_hold_focus_while_its_controls_are_held_back() {
	let built = build::whole_window_first_run();
	let held = held_for_no_session(&built.state);
	assert!(
		!held.is_empty(),
		"the first-run projection must hold the composer's controls back; it held none"
	);

	let focused = driven(built.state, |session| {
		session
			.update(|view, window, cx| {
				view
					.composer()
					.is_some_and(|editor| editor.read(cx).focus_handle().is_focused(window))
			})
			.expect("the window reports what it focused")
	});

	assert!(
		!focused,
		"the composer holds the keyboard while {} of its controls send nothing: {held:?}",
		held.len()
	);
}

#[test]
fn the_composer_holds_focus_once_a_session_is_open() {
	let built = build::whole_window_rest();
	assert_eq!(
		held_for_no_session(&built.state),
		Vec::<String>::new(),
		"a session is open, so no control is held back for want of one"
	);

	let focused = driven(built.state, |session| {
		session
			.update(|view, window, cx| {
				view
					.composer()
					.is_some_and(|editor| editor.read(cx).focus_handle().is_focused(window))
			})
			.expect("the window reports what it focused")
	});

	assert!(focused, "the first frame of an open session puts the keyboard in the composer");
}
