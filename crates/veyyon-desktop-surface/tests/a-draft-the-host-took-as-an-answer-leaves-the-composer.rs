//! WHY: the composer offered "Refine" only once a draft existed, and then sent
//! `Intent::Plan { accepted: false }` with the draft left behind. The
//! refinement the operator typed reached nothing: the agent was told a
//! refinement had been asked for and never what it was, and the text stayed in
//! the composer, so the rail went on stating it as unsent under a session that
//! had already answered. The free-text answer to a question had the second
//! half of the same defect: `Intent::Reply` carried the draft to the host and
//! `track_submission` did not know it, so an answered question left its answer
//! sitting in the editor.
//!
//! CLASS CLOSED: an answer whose payload IS the draft not being treated as the
//! draft going out. Both halves are pinned here: what the composer sends at a
//! plan, and which intents consume the draft once the host has taken them. The
//! set is pinned by exact equality against a space derived at run time from
//! `IntentDiscriminants`, so a new intent that carries composer text arrives as
//! a red test rather than as a draft nobody clears; a new variant defaults to
//! "does not carry the draft", which is the answer that loses no text.
//!
//! NOT CAUGHT: what the host does with the refinement once it has it, which is
//! `packages/coding-agent/test/gui-host/
//! a-plan-sent-back-carries-the-refinement-it-was-answered-with.test.ts`;
//! the rail's own drawing of an unsent draft, which
//! `crates/veyyon-desktop/tests/
//! a-draft-left-in-a-session-is-stated-in-the-rail.rs` owns; and the native
//! paint of either, which `proof/scenes/desktop-plan-refine.sh` records.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;
mod support;

use composer_layout::{TurnPhaseDiscriminant, build_state_for_phase, render_session};
use support::intent_samples::every_intent;
use veyyon_desktop_model::RequestId;
use veyyon_desktop_surface::{Intent, IntentDiscriminants, composer::TurnPhase, fixture};

/// The draft every case starts with, and the payload each carrier is built to
/// carry, so a cleared composer is only ever explained by the intent under
/// test.
const DRAFT: &str = "split step two into its own turn";

/// The intents whose payload is the composer's own text, worked out from what
/// the operator typed rather than from `track_submission`: a prompt, the two
/// running-turn submissions, and the free-text answer to a question. A plan is
/// not here -- it carries the draft only when it carries a refinement, which
/// `carries_the_draft` decides below.
const CARRIERS: [IntentDiscriminants; 4] = [
	IntentDiscriminants::Send,
	IntentDiscriminants::Steer,
	IntentDiscriminants::Queue,
	IntentDiscriminants::Reply,
];

/// Whether answering `intent` means the draft went out with it.
fn carries_the_draft(intent: &Intent) -> bool {
	if CARRIERS.contains(&IntentDiscriminants::from(intent)) {
		return true;
	}
	match intent {
		// The card's own revise row answers with no refinement, so a draft
		// beside it is text the operator is still writing.
		Intent::Plan { feedback, .. } => !feedback.trim().is_empty(),
		_ => false,
	}
}

/// The same intent with `DRAFT` as its payload, so the composer holds exactly
/// what the answer carries. An intent that carries no text is unchanged.
fn carrying_the_draft(intent: Intent) -> Intent {
	match intent {
		Intent::Send { attachments, .. } => Intent::Send { text: DRAFT.to_owned(), attachments },
		Intent::Steer(_) => Intent::Steer(DRAFT.to_owned()),
		Intent::Queue(_) => Intent::Queue(DRAFT.to_owned()),
		Intent::Reply { card, .. } => Intent::Reply { card, text: DRAFT.to_owned() },
		Intent::Plan { card, accepted, feedback } => Intent::Plan {
			card,
			accepted,
			feedback: if feedback.trim().is_empty() {
				feedback
			} else {
				DRAFT.to_owned()
			},
		},
		other => other,
	}
}

#[test]
fn only_an_answer_whose_payload_is_the_draft_consumes_the_draft() {
	for sample in every_intent() {
		let intent = carrying_the_draft(sample);
		let expected = if carries_the_draft(&intent) {
			""
		} else {
			DRAFT
		};
		let mut state = fixture::populated();
		state.turn = TurnPhase::Idle;
		render_session(state, Some(DRAFT), 1440, 900, |session| {
			session
				.update(|view, _window, cx| {
					view.track_submission(RequestId(7), &intent);
					view.finish_submission(RequestId(7), true, cx);
					assert_eq!(
						view.composer().expect("editor").read(cx).text(),
						expected,
						"{intent:?} left the composer holding the wrong text",
					);
				})
				.expect("answered draft");
		});
	}
}

#[test]
fn a_refusal_leaves_the_refinement_where_the_operator_can_send_it_again() {
	let mut state = fixture::populated();
	state.turn = TurnPhase::Idle;
	let refined = Intent::Plan { card: 0, accepted: false, feedback: DRAFT.to_owned() };
	render_session(state, Some(DRAFT), 1440, 900, |session| {
		session
			.update(|view, _window, cx| {
				view.track_submission(RequestId(3), &refined);
				assert_eq!(
					view.finish_submission(RequestId(3), false, cx),
					None,
					"a refused answer names no session, so no draft is dropped for it",
				);
				assert_eq!(view.composer().expect("editor").read(cx).text(), DRAFT);
			})
			.expect("refused refinement");
	});
}

#[test]
fn refining_a_plan_from_the_composer_sends_the_draft_and_then_gives_it_up() {
	let (state, has_text) = build_state_for_phase(TurnPhaseDiscriminant::PlanPendingWithText);
	assert!(has_text, "a refinement is the phase that has a draft");
	render_session(state, Some(DRAFT), 1440, 900, |session| {
		session
			.update(|view, _window, cx| {
				view.submit_primary_turn_action(cx);
				let intents = view.drain_intents();
				assert_eq!(
					intents,
					vec![Intent::Plan { card: 0, accepted: false, feedback: DRAFT.to_owned() }],
					"the plan goes back with the refinement the draft states",
				);
				assert_eq!(
					view.composer().expect("editor").read(cx).text(),
					DRAFT,
					"the refinement stays until the host has taken it",
				);
				view.track_submission(RequestId(1), &intents[0]);
				view.finish_submission(RequestId(1), true, cx);
				assert_eq!(view.composer().expect("editor").read(cx).text(), "");
			})
			.expect("refined plan");
	});
}
