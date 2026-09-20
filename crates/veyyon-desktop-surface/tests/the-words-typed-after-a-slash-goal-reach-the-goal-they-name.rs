//! WHY: `/goal` is one row that means two things. Typed bare it discloses the
//! goal the session already has; typed with words after it, those words are
//! the objective. The row is ranked on its name alone, so the remainder is
//! carried by the dispatch rather than by the ranker, and a dispatch that
//! dropped it stood up a goal with an empty objective or toggled a card the
//! operator was trying to fill in.
//!
//! CLASS CLOSED: the remainder reaching `Intent::SetGoal` verbatim, interior
//! spacing and punctuation included, for every casing the command is typed
//! in; and a bare `/goal`, in every casing and with trailing whitespace,
//! reaching `Intent::ToggleGoalCard` instead. Both are driven through the
//! composer of a real window, so the draft the command was typed into is
//! asserted cleared as well.
//!
//! NOT CAUGHT: which words are controls rather than objectives, and the
//! ranking itself, both owned by
//! `crates/veyyon-desktop-surface/tests/
//! a-slash-command-taking-an-argument-is-ranked-on-its-name-alone-and-dispatches-the-remainder.rs`.

#[path = "support/slash-argument/mod.rs"]
mod slash_argument;

use std::{cell::RefCell, rc::Rc};

use slash_argument::{cases, options, selected_for, shell};
use veyyon_desktop_scene::{HeadlessSession, headless::headless_context};
use veyyon_desktop_surface::{Intent, fixture, palette::commands::command_items};

#[test]
fn the_objective_typed_after_the_command_reaches_the_goal_verbatim() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let state = fixture::populated();
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(state, Rc::clone(&drained))).expect("opens");

	let objectives = [
		"Keep the desktop parity ledger honest",
		"maintain   exact   parity   with   terminal",
		"fix issue #123 (critical boundary condition)",
	];

	for objective in objectives {
		for typed in cases("/goal") {
			let draft = format!("{typed} {objective}");
			assert_eq!(
				selected_for(&mut session, &draft).as_deref(),
				Some("/goal"),
				"{draft:?} must select /goal"
			);

			drained.borrow_mut().clear();
			session
				.update(|view, _, cx| view.submit_primary_turn_action(cx))
				.expect("the draft submits");

			let sent = drained.borrow().clone();
			assert_eq!(sent.len(), 1, "expected one intent for {draft:?}, got {sent:?}");
			match &sent[0] {
				Intent::SetGoal { objective: sent, token_budget } => {
					assert_eq!(
						sent, objective,
						"the objective is the remainder, interior spacing included"
					);
					assert_eq!(*token_budget, None, "no budget was typed, so none is sent");
				},
				other => panic!("expected Intent::SetGoal, got {other:?}"),
			}

			session
				.update(|view, _, _| {
					assert_eq!(view.composer_text(), "", "the draft the command was typed into clears");
				})
				.expect("composer text checked");
		}
	}
}

#[test]
fn the_command_typed_bare_discloses_the_goal_the_session_has() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let state = fixture::populated();
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(state, Rc::clone(&drained))).expect("opens");

	let goal = command_items()
		.into_iter()
		.find(|item| item.title == "/goal")
		.expect("/goal is a command row");
	assert_eq!(goal.intent_for_typed("/goal"), Some(Intent::ToggleGoalCard));
	assert_eq!(
		goal.intent_for_typed("/GOAL   "),
		Some(Intent::ToggleGoalCard),
		"trailing whitespace is not an objective"
	);

	for typed in cases("/goal") {
		assert_eq!(
			selected_for(&mut session, &typed).as_deref(),
			Some("/goal"),
			"{typed:?} must select /goal"
		);

		let was_open = session
			.update(|view, _, _| view.state().goal_card_open)
			.expect("reads whether the card is open");

		session
			.update(|view, _, cx| view.submit_primary_turn_action(cx))
			.expect("the draft submits");

		session
			.update(|view, _, _| {
				assert_ne!(view.state().goal_card_open, was_open, "{typed:?} toggles the card");
				assert_eq!(view.composer_text(), "", "the command is consumed from the draft");
			})
			.expect("state verified");
	}
}
