//! WHY: the titlebar's centre is an editor over the open session's name, and
//! it is the only way to rename a session from the window. It is the same
//! shape as the field that made authentication impossible — a control drawn as
//! an input whose value never reaches the action beside it — with one more way
//! to go wrong: the commit carries a session id, so a field that sends the
//! right text under the wrong id renames a session the operator was not
//! looking at, and the rail shows the name land on somebody else's row.
//!
//! CLASS CLOSED: the rename commit, driven through the editor the titlebar
//! retained, the keys an operator presses, and the row the window has open —
//! the typed name reaching the host under the open session's id, a name the
//! window refuses reaching nothing, and the escape that abandons the edit. The
//! `FieldKey` union is checked here by an exhaustive match naming the suite
//! that owns each field's commit, so a sixth field cannot be added without
//! recording where it is proven. Held shut against:
//!
//! 1. A rename that sends the name the host last reported rather than the one
//!    that was typed.
//! 2. A rename that names another session — the first row, the previously open
//!    one, or the row the field was first drawn for.
//! 3. An empty or blank name sent on to the host, which renames a session to
//!    nothing, instead of being refused where it was typed (§9.3).
//! 4. A refusal that is stated and then sends anyway, or sends and states
//!    nothing.
//! 5. An escape that commits, or that leaves the operator's abandoned text in
//!    the field for the next frame to send.
//!
//! NOT CAUGHT: what the host does with the new name, which
//! `an-intent-maps-to-the-actions-the-host-answers` owns; and the masking and
//! clipboard rules of the secret field, which are that field's own suites.

#[path = "support/model-picker/mod.rs"]
#[allow(dead_code, reason = "this binary uses the window helper alone")]
mod model_picker;

use model_picker::window;
use veyyon_desktop_surface::{FieldKey, Intent, ShellState, fixture};

/// The name typed over whatever the field held.
const TYPED: &str = "Reticulating splines";

/// Which suite proves the commit of each field the window draws.
///
/// An exhaustive match with no wildcard arm: a sixth `FieldKey` stops this
/// compiling until its commit is proven somewhere and named here.
fn proven_by(key: &FieldKey) -> &'static str {
	match key {
		FieldKey::AuthSecret => "a-field-sends-what-the-operator-typed-into-it",
		FieldKey::Setting(_) => "a-setting-row-sends-the-value-its-field-holds",
		FieldKey::SessionRename(_) => "the-titlebar-renames-the-session-it-is-naming",
		FieldKey::Keybinding(_) => "a-keybinding-override-that-shadows-nothing-is-reported",
		FieldKey::TaskPrompt => "contextual-surfaces-intent-and-interaction-contracts",
	}
}

/// The shell with a session open, which is the state that draws the field.
fn shell() -> ShellState {
	fixture::populated()
}

/// Types `text` over the whole of what the titlebar's field holds, through the
/// editor the frame retained and the keys an operator presses.
///
/// The field is focused by hand rather than by a click at its pixels: the
/// titlebar's centre is a band of the chrome and the drag region owns the
/// press, so a click there moves the window rather than the caret. What is
/// under test is the commit, and the keystrokes below travel the editor's own
/// dispatch tree either way.
fn retype(
	session: &mut veyyon_desktop_scene::session::HeadlessSession<
		'_,
		veyyon_desktop_surface::ShellView,
	>,
	row: u64,
	text: &str,
) {
	let editor = session
		.update(|view, _window, _cx| view.retained_field(&FieldKey::SessionRename(row)))
		.expect("the titlebar's field is read back")
		.expect("the titlebar draws a field for the open session");
	session
		.update(|_view, window, cx| {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		})
		.expect("the field takes the keyboard");
	session.frame().expect("the focused field draws");
	assert!(
		session.keystroke("ctrl-a").expect("select-all dispatches"),
		"the field did not answer select-all, so the typing below would append"
	);
	if text.is_empty() {
		assert!(
			session
				.keystroke("backspace")
				.expect("backspace dispatches"),
			"the field did not answer backspace"
		);
	} else {
		session.type_text(text).expect("the name is typed");
	}
	session.frame().expect("the typed field draws");
}

#[test]
fn every_field_the_window_draws_states_the_suite_that_proves_its_commit() {
	// The payloads are stand-ins: what is asserted is that each variant of the
	// union names a suite, which the match above cannot do for a new one.
	for key in [
		FieldKey::AuthSecret,
		FieldKey::Setting("theme".to_owned()),
		FieldKey::SessionRename(1),
		FieldKey::Keybinding("NewSession".to_owned()),
		FieldKey::TaskPrompt,
	] {
		assert!(!proven_by(&key).is_empty(), "{key:?} names no suite that proves its commit");
	}
}

#[test]
fn the_name_that_was_typed_reaches_the_host_under_the_open_session() {
	let row = shell().current_id;
	let sent = window(shell(), |session| {
		session.frame().expect("the shell draws");
		session
			.update(|view, _window, _cx| {
				view.drain_intents();
			})
			.expect("the opening frame's intents are dropped");
		retype(session, row, TYPED);
		assert!(
			session
				.keystroke("enter")
				.expect("the return key dispatches"),
			"the return key reached no handler over the field"
		);
		session
			.update(|view, _window, _cx| {
				assert!(view.notice().is_none(), "a name the window accepted was also refused");
				view.drain_intents()
			})
			.expect("what the commit sent is read back")
	});

	assert_eq!(
		sent,
		vec![Intent::RenameSession { session: row, title: TYPED.to_owned() }],
		"the commit sent something other than the typed name for the open session"
	);
}

#[test]
fn a_rename_follows_the_session_the_window_opened() {
	// Another row of the seeded rail, so the id under test is neither the one
	// the field was first drawn for nor the first row of the queue.
	let other = window(shell(), |session| {
		session.frame().expect("the shell draws");
		session
			.update(|view, _window, _cx| {
				view
					.state()
					.sections
					.iter()
					.flat_map(|(_, rows)| rows.iter())
					.map(|row| row.id)
					.find(|id| *id != view.state().current_id)
					.expect("the seeded rail lists a second session")
			})
			.expect("the rail rows are read back")
	});

	let sent = window(shell(), |session| {
		session.frame().expect("the shell draws");
		session
			.update(|view, _window, cx| {
				view.dispatch(Intent::SelectSession(other), cx);
				view.drain_intents();
			})
			.expect("the other session opens");
		session.frame().expect("the opened session draws");
		retype(session, other, TYPED);
		assert!(
			session
				.keystroke("enter")
				.expect("the return key dispatches"),
			"the return key reached no handler over the field"
		);
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("what the commit sent is read back")
	});

	assert_eq!(
		sent,
		vec![Intent::RenameSession { session: other, title: TYPED.to_owned() }],
		"the commit named a session other than the one the window has open"
	);
}

#[test]
fn a_blank_name_is_refused_where_it_was_typed_and_sent_nowhere() {
	let row = shell().current_id;
	for blank in ["", "   "] {
		let (sent, notice) = window(shell(), |session| {
			session.frame().expect("the shell draws");
			session
				.update(|view, _window, _cx| {
					view.drain_intents();
				})
				.expect("the opening frame's intents are dropped");
			retype(session, row, blank);
			assert!(
				session
					.keystroke("enter")
					.expect("the return key dispatches"),
				"the return key reached no handler over the field"
			);
			session
				.update(|view, _window, _cx| (view.drain_intents(), view.notice().map(str::to_owned)))
				.expect("what the commit sent is read back")
		});

		assert!(sent.is_empty(), "a blank name was sent to the host as {sent:?}");
		assert_eq!(
			notice.as_deref(),
			Some("A session name cannot be empty"),
			"a name the window refused was refused silently"
		);
	}
}

#[test]
fn an_escape_abandons_the_edit_and_leaves_the_reported_name_in_the_field() {
	let row = shell().current_id;
	let reported = shell()
		.row(row)
		.map(|row| row.title.clone())
		.expect("the open session holds a row");

	let (sent, held) = window(shell(), |session| {
		session.frame().expect("the shell draws");
		session
			.update(|view, _window, _cx| {
				view.drain_intents();
			})
			.expect("the opening frame's intents are dropped");
		retype(session, row, TYPED);
		assert!(
			session
				.keystroke("escape")
				.expect("the escape key dispatches"),
			"the escape key reached no handler over the field"
		);
		session
			.update(|view, _window, cx| {
				let text = view
					.retained_field(&FieldKey::SessionRename(row))
					.map(|editor| editor.read(cx).text().to_owned());
				(view.drain_intents(), text)
			})
			.expect("what the escape left is read back")
	});

	assert!(sent.is_empty(), "the escape committed the abandoned name as {sent:?}");
	assert_eq!(
		held.as_deref(),
		Some(reported.as_str()),
		"the field kept the abandoned text for the next commit to send"
	);
}
