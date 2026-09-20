//! WHY: the terminal reaches one model list by two commands that differ only
//! in what survives the session. `/model` writes the choice as the default
//! role, `/switch` runs this session on it and leaves the operator's
//! configuration alone. The window drew one picker and every row of it wrote
//! the default role, so trying a model here repointed every later session, and
//! the difference is invisible on the frame: both pickers list the same rows in
//! the same order, and the only thing that tells them apart is the field the
//! row sends.
//!
//! CLASS CLOSED: every model row of both pickers, reached the way an operator
//! reaches it — the command surface, the command's own spelling, the return
//! key — carries the persistence its command stands for. The sweep is derived
//! from the catalogue the host reported at run time, so a model added to the
//! answer is swept too, and both commands are swept from the same list, which
//! is what tells a picker wired to the wrong flag from one wired to none.
//! Held shut against:
//!
//! 1. Either command opening the other's picker.
//! 2. One row of a picker carrying a different flag than its neighbours, which
//!    is what a flag read from the row rather than from the picker looks like.
//! 3. The composer chord opening a session-only picker, so a chord and a
//!    command that name the same control disagree.
//!
//! NOT CAUGHT: what the host does with the flag, which
//! `packages/coding-agent/test/gui-host/
//! a-model-tried-for-one-session-is-not-the-operators-default.test.ts` owns end
//! to end against a real settings file.

#[path = "support/model-picker/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared catalogue helpers")]
mod model_picker;

use model_picker::{choice_of, confirm, control, open_models, ranked, selected, session};
use veyyon_desktop_surface::{Intent, ModelChoice};

/// Opens a picker through the command surface, by the spelling an operator
/// types, and asserts the row the ranker left selected is that command's own.
fn open_by_command(
	session: &mut veyyon_desktop_scene::session::HeadlessSession<
		'_,
		veyyon_desktop_surface::ShellView,
	>,
	spelling: &str,
) {
	session
		.update(|view, window, cx| {
			view.open_command_palette(window, cx);
			view.drain_intents();
		})
		.expect("the command surface opens");
	session.frame().expect("the command surface draws");
	session.type_text(spelling).expect("the command is typed");
	session.frame().expect("the ranked frame draws");
	assert_eq!(
		selected(session).as_deref(),
		Some(spelling),
		"typing {spelling} left another command selected"
	);
	assert!(
		session
			.keystroke("enter")
			.expect("the return key dispatches"),
		"the return key reached no handler over the command surface"
	);
	session.frame().expect("the model rows draw");
	session
		.update(|view, _window, _cx| view.drain_intents())
		.expect("the opening intents are dropped");
}

/// Every model the picker opened by `spelling` sends, with the persistence each
/// row carried.
fn choices_from(spelling: &str) -> Vec<(ModelChoice, bool)> {
	let titles = session(|session| {
		open_by_command(session, spelling);
		ranked(session)
	});
	assert_eq!(
		titles.len(),
		control().options.len(),
		"{spelling} listed a different catalogue than the host reported"
	);
	titles
		.iter()
		.map(|title| {
			let sent = session(|session| {
				open_by_command(session, spelling);
				let index = ranked(session)
					.iter()
					.position(|ranked| ranked == title)
					.expect("the row is in the list it was read from");
				for _ in 0..index {
					assert!(
						session.keystroke("down").expect("the arrow key dispatches"),
						"the down key reached no handler over the picker"
					);
				}
				session.frame().expect("the moved selection draws");
				confirm(session)
			});
			match sent.into_iter().next() {
				Some(Intent::SelectModel { choice, persist }) => {
					assert_eq!(choice, choice_of(title), "the row titled {title} sent another model");
					(choice, persist)
				},
				other => panic!("the row titled {title} sent {other:?} instead of a model"),
			}
		})
		.collect()
}

#[test]
fn the_model_command_writes_every_row_as_the_default_role() {
	let sent = choices_from("/model");
	assert!(
		sent.iter().all(|(_, persist)| *persist),
		"a row of the /model picker was sent as a session-only model"
	);
}

#[test]
fn the_switch_command_holds_every_row_for_this_session_only() {
	let sent = choices_from("/switch");
	assert!(
		sent.iter().all(|(_, persist)| !*persist),
		"a row of the /switch picker was written as the operator's default"
	);
}

#[test]
fn both_commands_offer_the_same_models() {
	let persisted: Vec<ModelChoice> = choices_from("/model")
		.into_iter()
		.map(|(choice, _)| choice)
		.collect();
	let session_only: Vec<ModelChoice> = choices_from("/switch")
		.into_iter()
		.map(|(choice, _)| choice)
		.collect();
	assert_eq!(
		persisted, session_only,
		"the two commands opened different catalogues, so one of them is not the model list"
	);
}

#[test]
fn the_composer_chord_writes_the_default_role() {
	// The chip and the chord open the picker `/model` opens, not the
	// session-only one: a control that looks like the command it duplicates and
	// answers differently is the defect this file exists for.
	let sent = session(|session| {
		open_models(session);
		confirm(session)
	});
	match sent.into_iter().next() {
		Some(Intent::SelectModel { persist, .. }) => {
			assert!(persist, "the composer's own model picker sent a session-only model");
		},
		other => panic!("the composer's model picker sent {other:?} instead of a model"),
	}
}
