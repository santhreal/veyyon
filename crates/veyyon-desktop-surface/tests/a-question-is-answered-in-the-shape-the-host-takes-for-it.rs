//! WHY THIS SUITE EXISTS
//!
//! A question the host raises with options is settled by the index of one of
//! them; a question raised with none is settled by text. The host holds a
//! decision answered in the other shape open and refuses the answer, so an
//! answer in the wrong shape is not a slow answer, it is no answer: the window
//! took the card down on the attempt, the agent kept waiting on the decision,
//! and the turn could not be finished from the surface that raised it.
//!
//! The window sent the wrong shape from two places. The composer's primary
//! action, which a question turns into `Answer`, sent the draft as free text
//! for a question that offers options; with an empty draft it sent the FIRST
//! option, an answer nobody chose. The question card offered "Reply with
//! composer" beside the options for the same question, which sent that same
//! refused shape.
//!
//! THE CLASS THIS CLOSES: an answer gesture whose payload the decision it
//! answers is not answered with. The suite sweeps every turn phase from
//! `TurnPhaseDiscriminant` -- which now carries a question of each shape --
//! drives every gesture that answers one on the real view (the card's option
//! rows, their digit keys, and the composer's primary action from both the
//! pointer and the keyboard, under an empty and a typed draft), and pins what
//! each raises by exact equality. A gesture that starts answering in another
//! shape, a phase that starts answering from the composer, or a new turn
//! phase turns this red.
//!
//! WHAT IT DOES NOT CATCH: that the host refuses the other shape and keeps the
//! decision open, which is
//! `test/gui-host/a-decision-reaches-the-desktop-and-its-answer-comes-back.
//! test.ts`; the projection that marks the composer's answer unavailable for a
//! question with options, which is
//! `control-availability-and-contextual-statuses-project-from-capabilities.rs`;
//! and the round trip of an answer the host accepted, which is
//! `an-intent-maps-to-the-actions-the-host-answers.rs`.
//!
//! It also cannot see how the control is PAINTED while it carries no answer.
//! The headless capture records fill, border and text, not the opacity and
//! cursor that dim a control with an empty draft, so a control that acts
//! correctly and looks live is caught by the native capture of the scene
//! rather than here.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use composer_layout::{
	TurnPhaseDiscriminant, build_state_for_phase, render_session, render_session_with_keys,
	seed_answer_availability,
};
use strum::IntoEnumIterator;
use veyyon_desktop_scene::Captured;
use veyyon_desktop_surface::{Card, Intent, composer::TurnPhase};
use veyyon_gpui::{Point, px};

/// The label the card draws for the answer that is the composer's own text.
const REPLY_ROW: &str = "Reply with the composer's text";

/// The window the gestures are driven in: wide enough that no width shed is in
/// play, so a card draws every row it has.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The question a phase is parked on, when the phase is parked on one.
///
/// Read from the turn phase rather than from the cards, because the fixture
/// every state is built on already attaches one card of each kind: a state
/// that carries a question card is not a state waiting on a question.
fn question_of(discriminant: TurnPhaseDiscriminant) -> Option<(String, Vec<String>)> {
	let (state, _) = build_state_for_phase(discriminant);
	if !matches!(state.turn, TurnPhase::QuestionPending { .. }) {
		return None;
	}
	state.cards.iter().find_map(|card| match card {
		Card::Question { prompt, options } => Some((prompt.clone(), options.clone())),
		_ => None,
	})
}

/// Where the frame drew `label`, as the centre of the one run whose text is
/// exactly it. A label drawn twice is refused rather than guessed at.
fn drawn_once(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the frame draws `{label}` once, drew {}", runs.len());
	runs[0]
}

/// Whether the frame drew `label` at all.
fn drew(captured: &Captured, label: &str) -> bool {
	captured
		.text_runs
		.iter()
		.any(|run| run.text.as_ref().trim() == label)
}

#[test]
fn a_card_offers_the_composer_s_text_only_where_the_question_takes_text() {
	let mut offered: Vec<(String, bool, usize)> = Vec::new();
	for discriminant in TurnPhaseDiscriminant::iter() {
		let Some((prompt, options)) = question_of(discriminant) else {
			continue;
		};
		let (state, has_text) = build_state_for_phase(discriminant);
		let seed = has_text.then_some("typed");
		let drawn = render_session(state, seed, WIDTH, HEIGHT, |session| {
			let captured = session.frame().expect("frame renders");
			assert!(drew(&captured, &prompt), "the card states the question it is asking");
			for (index, label) in options.iter().enumerate() {
				let numbered = format!("{}. {}", index + 1, label);
				assert!(
					drew(&captured, &numbered),
					"an option is drawn with the digit that answers it, missing `{numbered}`"
				);
			}
			drew(&captured, REPLY_ROW)
		});
		offered.push((format!("{discriminant:?}"), drawn, options.len()));
	}

	assert_eq!(
		offered,
		vec![
			("QuestionPendingChoice".to_owned(), false, 3),
			("QuestionPendingFreeText".to_owned(), true, 0),
		],
		"the card offers the composer's text exactly where the question is answered with text"
	);
}

#[test]
fn every_gesture_that_answers_a_question_raises_the_shape_that_question_takes() {
	let mut raised: Vec<(String, String, Vec<String>)> = Vec::new();
	for discriminant in TurnPhaseDiscriminant::iter() {
		let Some((_, options)) = question_of(discriminant) else {
			continue;
		};
		let name = format!("{discriminant:?}");

		// The composer's primary action, with the draft the phase carries.
		let (state, has_text) = build_state_for_phase(discriminant);
		let seed = has_text.then_some("a name I typed");
		let submitted = render_session(state, seed, WIDTH, HEIGHT, |session| {
			session.frame().expect("frame renders");
			seed_answer_availability(session);
			session
				.update(|view, _win, cx| view.submit_primary_turn_action(cx))
				.expect("the primary action is reached");
			session
				.update(|view, _win, _cx| view.drain_intents())
				.expect("intents drain")
		});
		raised.push((
			name.clone(),
			"composer".to_owned(),
			submitted
				.iter()
				.map(|intent| format!("{intent:?}"))
				.collect(),
		));

		// The same action with nothing typed: an empty draft is not an answer,
		// whatever shape the question takes.
		let (empty_state, _) = build_state_for_phase(discriminant);
		let on_empty = render_session(empty_state, None, WIDTH, HEIGHT, |session| {
			session.frame().expect("frame renders");
			seed_answer_availability(session);
			session
				.update(|view, _win, cx| view.submit_primary_turn_action(cx))
				.expect("the primary action is reached");
			session
				.update(|view, _win, _cx| view.drain_intents())
				.expect("intents drain")
		});
		raised.push((
			name.clone(),
			"composer-empty".to_owned(),
			on_empty
				.iter()
				.map(|intent| format!("{intent:?}"))
				.collect(),
		));

		// The digit keys, which answer an option while the draft is empty. Every
		// digit the keymap binds is pressed, so one past the last option is a
		// digit in the draft and not an answer to an option that is not there.
		let bound_digits = 5;
		for index in 0..bound_digits {
			let (digit_state, _) = build_state_for_phase(discriminant);
			let (typed, pressed) =
				render_session_with_keys(digit_state, None, WIDTH, HEIGHT, |session| {
					session.frame().expect("frame renders");
					session
						.keystroke(&format!("{}", index + 1))
						.expect("the digit reaches the surface");
					let typed = session
						.update(|view, _win, _cx| view.has_composer_text())
						.expect("the draft is readable");
					let pressed = session
						.update(|view, _win, _cx| view.drain_intents())
						.expect("intents drain");
					(typed, pressed)
				});
			if index < options.len() {
				assert_eq!(
					pressed,
					vec![Intent::Answer { card: 0, option: index }],
					"{name}: the digit {} answers its own option",
					index + 1
				);
				assert!(!typed, "{name}: a digit that answered the question is not also typed");
			} else {
				assert_eq!(
					pressed,
					Vec::new(),
					"{name}: the digit {} answers an option this question does not offer",
					index + 1
				);
				assert!(typed, "{name}: the digit is typed into the draft instead");
			}
		}

		// The option rows themselves, pressed where the frame drew them.
		for (index, label) in options.iter().enumerate() {
			let (row_state, _) = build_state_for_phase(discriminant);
			let numbered = format!("{}. {}", index + 1, label);
			let clicked = render_session(row_state, None, WIDTH, HEIGHT, |session| {
				let captured = session.frame().expect("frame renders");
				let at = drawn_once(&captured, &numbered);
				session
					.click(Point { x: px(at.x), y: px(at.y) })
					.expect("press the option the card drew");
				session
					.update(|view, _win, _cx| view.drain_intents())
					.expect("intents drain")
			});
			assert_eq!(
				clicked,
				vec![Intent::Answer { card: 0, option: index }],
				"{name}: pressing `{numbered}` answers that option"
			);
		}
	}

	assert_eq!(
		raised,
		vec![
			// A question that offers options is answered by one of them, so the
			// composer sends nothing for it under either draft.
			("QuestionPendingChoice".to_owned(), "composer".to_owned(), Vec::new()),
			("QuestionPendingChoice".to_owned(), "composer-empty".to_owned(), Vec::new()),
			("QuestionPendingFreeText".to_owned(), "composer".to_owned(), vec![
				r#"Reply { card: 0, text: "a name I typed" }"#.to_owned()
			],),
			("QuestionPendingFreeText".to_owned(), "composer-empty".to_owned(), Vec::new()),
		],
		"the composer answers a question only with the text a question of that shape takes"
	);
}
