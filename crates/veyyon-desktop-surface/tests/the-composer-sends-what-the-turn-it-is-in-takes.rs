//! WHY THIS SUITE EXISTS
//!
//! The composer carries one control for the turn, and what it sends depends on
//! the phase the turn is in and on whether a draft is in the editor. It sent
//! an answer for a question that is not answered with text: with a draft it
//! sent the draft, and with none it sent the FIRST option, an answer nobody
//! chose. The host refuses both for such a question and leaves the decision
//! open, so the turn could not be finished from the composer.
//!
//! THE CLASS THIS CLOSES: a phase in which the composer's control sends
//! something the phase does not take, or acts on an empty draft whose content
//! was to be the payload. The sweep reads every phase from
//! `TurnPhaseDiscriminant`, resolves the action the composer offers through
//! the production `primary_action`, and pins by exact equality what it does
//! with a draft and with none -- from the pointer and from the keyboard, which
//! must agree. A new phase, a changed payload, or an action that starts firing
//! on an empty draft turns this red.
//!
//! WHAT IT DOES NOT CATCH: which gesture answers a card (the card's own rows
//! and their digit keys), which is
//! `a-question-is-answered-in-the-shape-the-host-takes-for-it.rs`; the
//! projection that marks the answer unavailable, which is
//! `control-availability-and-contextual-statuses-project-from-capabilities.rs`;
//! and the paint of a control carrying no answer, since the headless capture
//! records fill, border and text but not the opacity and cursor that dim it.
//!
//! That paint is the one mutation this suite leaves green: making the answer
//! control actionable on an empty draft. It changes nothing else, because the
//! payload is guarded a second time where it is built -- the `Answer` arm of
//! `submit_primary_turn_action` matches on `has_text`, so an empty draft
//! raises no intent whichever way the control is painted -- and for a question
//! that offers options the projection already holds the control at the
//! unavailable opacity. Recorded in `proof/scenes/desktop-question-answer.sh`,
//! whose frames show that control dim beside an open question.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use composer_layout::{
	TurnPhaseDiscriminant, build_state_for_phase, composer_float_bounds, find_primary_action_hitbox,
	render_session, seed_answer_availability,
};
use strum::IntoEnumIterator;
use veyyon_desktop_surface::composer::primary_action;
use veyyon_gpui::Point;

/// The window the sweep runs in: wide enough that no width shed is in play.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

#[test]
fn pressing_the_composer_s_control_raises_what_submitting_it_raises() {
	let mut pressed: Vec<(String, bool, Vec<String>)> = Vec::new();
	for discriminant in TurnPhaseDiscriminant::iter() {
		for has_text in [true, false] {
			let (state, _) = build_state_for_phase(discriminant);
			let seed = has_text.then_some("a draft");
			let by_pointer = render_session(state, seed, WIDTH, HEIGHT, |session| {
				seed_answer_availability(session);
				let (_, _, right, bottom) = composer_float_bounds(session, WIDTH, HEIGHT);
				let captured = session.frame().expect("frame renders");
				let control = find_primary_action_hitbox(&captured.hitboxes, right, bottom)
					.expect("the composer draws its primary control in every phase");
				session
					.click(Point {
						x: control.origin.x + control.size.width / 2.0,
						y: control.origin.y + control.size.height / 2.0,
					})
					.expect("press the control the frame drew");
				session
					.update(|view, _win, _cx| view.drain_intents())
					.expect("intents drain")
			});

			let (again, _) = build_state_for_phase(discriminant);
			let by_keyboard = render_session(again, seed, WIDTH, HEIGHT, |session| {
				session.frame().expect("frame renders");
				seed_answer_availability(session);
				session
					.update(|view, _win, cx| view.submit_primary_turn_action(cx))
					.expect("the primary action is reached");
				session
					.update(|view, _win, _cx| view.drain_intents())
					.expect("intents drain")
			});

			assert_eq!(
				by_pointer, by_keyboard,
				"{discriminant:?} with draft {has_text}: the pointer and the keyboard raise the same \
				 answer"
			);
			pressed.push((
				format!("{discriminant:?}"),
				has_text,
				by_pointer
					.iter()
					.map(|intent| format!("{intent:?}"))
					.collect(),
			));
		}
	}

	let questions: Vec<&(String, bool, Vec<String>)> = pressed
		.iter()
		.filter(|(phase, ..)| phase.starts_with("QuestionPending"))
		.collect();
	assert_eq!(
		questions,
		vec![
			// The answer is an option, so pressing the composer's control
			// while this question is open raises nothing at all.
			&("QuestionPendingChoice".to_owned(), true, Vec::new()),
			&("QuestionPendingChoice".to_owned(), false, Vec::new()),
			&("QuestionPendingFreeText".to_owned(), true, vec![
				r#"Reply { card: 0, text: "a draft" }"#.to_owned()
			],),
			&("QuestionPendingFreeText".to_owned(), false, Vec::new()),
		],
		"the pointer answers a question only in the shape that question takes"
	);
}

#[test]
fn the_primary_action_acts_on_an_empty_draft_only_where_its_answer_is_not_the_draft() {
	let table: Vec<Row> = TurnPhaseDiscriminant::iter().map(row_for).collect();

	assert_eq!(
		table,
		vec![
			row("Idle", "Send", true, "Send", false),
			row("RunningSteer", "Steer", true, "Steer", false),
			row("RunningQueue", "Queue", true, "Queue", false),
			// The answer to a question that offers options is an option, so the
			// composer's own action is not the way to give it, under any draft.
			row("QuestionPendingChoice", "Answer", false, "Answer", false),
			row("QuestionPendingFreeText", "Answer", true, "Answer", false),
			row("ApprovalPending", "Approve", true, "Approve", true),
			row("PlanPendingEmpty", "Refine", true, "Accept", true),
			row("PlanPendingWithText", "Refine", true, "Accept", true),
		],
		"the primary action acts on an empty draft only where the draft is not its answer"
	);
}

/// One row of the sweep: the phase, then the action the composer offers and
/// whether submitting it acts, once with a draft and once with none.
type Row = (String, String, bool, String, bool);

/// Reads one row off the real phase.
fn row_for(discriminant: TurnPhaseDiscriminant) -> Row {
	let (state, _) = build_state_for_phase(discriminant);
	let (with_draft, _) = primary_action(&state.turn, true);
	let (on_empty, _) = primary_action(&state.turn, false);
	(
		format!("{discriminant:?}"),
		format!("{with_draft:?}"),
		acts_with_draft(discriminant, true),
		format!("{on_empty:?}"),
		acts_with_draft(discriminant, false),
	)
}

/// The same row, written the way the expectation reads it.
fn row(phase: &str, with_draft: &str, acted: bool, on_empty: &str, acted_empty: bool) -> Row {
	(phase.to_owned(), with_draft.to_owned(), acted, on_empty.to_owned(), acted_empty)
}

/// Whether the composer's primary action raises anything in `discriminant`,
/// with a draft or with none.
fn acts_with_draft(discriminant: TurnPhaseDiscriminant, has_text: bool) -> bool {
	let (state, _) = build_state_for_phase(discriminant);
	let seed = has_text.then_some("a draft");
	render_session(state, seed, WIDTH, HEIGHT, |session| {
		session.frame().expect("frame renders");
		seed_answer_availability(session);
		session
			.update(|view, _win, cx| view.submit_primary_turn_action(cx))
			.expect("the primary action is reached");
		let intents = session
			.update(|view, _win, _cx| view.drain_intents())
			.expect("intents drain");
		!intents.is_empty()
	})
}
