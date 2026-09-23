//! WHY: the share card drew a link field with no commit behind it. A return
//! on the field and a press of the `Join` beside it both reached
//! `commit_field`, which had no arm for `FieldKey::ShareLink` and fell through
//! its wildcard: the field took a link, cleared nothing, raised nothing, and
//! said nothing, so a guest holding a valid link could not enter the room from
//! the surface at all.
//!
//! CLASS CLOSED: the share link field either raises a `JoinShare` carrying
//! exactly the room the field states, or raises nothing and states why. Every
//! shape a typed link arrives in is swept — the plain link, one padded with
//! the whitespace a paste carries, an empty field and a field holding only
//! whitespace — and each is required to do one or the other. A commit that
//! sent an empty link to the host is what the host answers with a refusal the
//! surface never asked for, so no case here may raise one.
//!
//! The join is reached through the editor the drawn card registered, so a
//! field the surface stops drawing, or a commit wired to another key, fails
//! here rather than passing against a direct call.
//!
//! GAPS: what the host does with the link is `an-intent-maps-to-the-actions-
//! the-host-answers`'s subject, and which controls each share phase offers is
//! `each_share_phase_offers_only_the_controls_it_can_answer`'s. The link is
//! taken as typed: that a room exists behind it is the relay's answer, not the
//! field's.

use std::path::Path;

use veyyon_desktop_kit::{input::Editor, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Availability, Intent, Keymap, Overlay, ShareState, ShellState, ShellView, fixture,
	install_tokens,
};
use veyyon_gpui::{App, AppContext, Entity};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The room a guest was handed, in the spelling a relay mints.
const LINK: &str = "https://relay.example.com/s/ln4Xb2";

/// A window with the share card open on a session hosting nothing, which is
/// the one phase that draws the link field.
fn share_card_state() -> ShellState {
	let mut state = ShellState {
		overlay: Some(Overlay::Share(Box::new(ShareState::new()))),
		..fixture::populated()
	};
	// Whether the gate holds the control back is another suite's subject, so
	// the join is offered here and this one reads what a submit raises.
	state
		.controls
		.set_availability(SurfaceId::ShareJoinButton, Availability::Enabled);
	state
}

/// Opens a window on the share card and runs `drive` against it.
fn driven<R>(drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, share_card_state()))
	})
	.expect("session opens");
	drive(&mut session)
}

/// What a submit left behind: what it raised, what the card states, what the
/// field held before the submit and what it holds after it.
struct Submitted {
	intents: Vec<Intent>,
	notice:  Option<String>,
	held:    String,
	left:    String,
}

/// Puts `link` in the card's field and submits it, the way a return on the
/// field and the `Join` beside it both do.
fn join(link: &str) -> Submitted {
	let link = link.to_owned();
	driven(|session| {
		session.frame().expect("the share card renders");
		let (editor, held): (Entity<Editor>, String) = session
			.update(move |view, _window, cx| {
				let editor = view.share_link_field_editor(cx);
				editor.update(cx, |editor, cx| editor.set_text(link, cx));
				// Read back rather than trusting what was set: a single-line
				// field is entitled to drop a newline a paste carried, and
				// what it holds is what the submit reads.
				let held = editor.read(cx).text().to_owned();
				(editor, held)
			})
			.expect("the share card draws a link field");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		session
			.update(|view, _window, cx| view.submit_share_join(cx))
			.expect("submit the link the field states");
		session
			.update(move |view, _window, cx| Submitted {
				intents: view.drain_intents(),
				notice: view.notice().map(str::to_owned),
				held,
				left: editor.read(cx).text().to_owned(),
			})
			.expect("read back what the submit did")
	})
}

#[test]
fn the_link_the_field_states_is_the_room_the_join_names() {
	let submitted = join(LINK);
	assert_eq!(
		submitted.intents,
		vec![Intent::JoinShare { session: None, link: LINK.to_owned() }],
		"the submit raises one join, for the room the field states"
	);
	assert_eq!(submitted.left, "", "the field is emptied by the join it sent");
	assert_eq!(submitted.notice, None, "a link that was taken states no refusal");
}

#[test]
fn a_link_pasted_with_its_whitespace_joins_the_same_room() {
	// A link copied out of a chat window arrives with a newline on it, and the
	// relay answers the address alone.
	let submitted = join(&format!("  {LINK}\n"));
	assert_eq!(
		submitted.intents,
		vec![Intent::JoinShare { session: None, link: LINK.to_owned() }],
		"the padding a paste carries is not part of the room"
	);
}

#[test]
fn a_field_that_states_no_room_joins_nothing_and_says_why() {
	for text in ["", "   ", "\t\n"] {
		let submitted = join(text);
		assert!(
			submitted.intents.is_empty(),
			"a field holding {text:?} raised {:?} rather than nothing",
			submitted.intents
		);
		assert_eq!(
			submitted.notice.as_deref(),
			Some("A link is required to join a share"),
			"a field holding {text:?} states why it joined nothing"
		);
		assert_eq!(submitted.left, submitted.held, "a refused submit leaves the field as it was");
	}
}

#[test]
fn no_submit_of_the_share_field_ever_joins_an_empty_room() {
	// The defect the host answers: a `JoinShare` whose link is empty asks the
	// relay for a room that cannot exist.
	for text in ["", "   ", LINK, &format!(" {LINK} ")] {
		for intent in join(text).intents {
			if let Intent::JoinShare { link, .. } = intent {
				assert!(!link.trim().is_empty(), "a join was raised for an empty room from {text:?}");
			}
		}
	}
}
