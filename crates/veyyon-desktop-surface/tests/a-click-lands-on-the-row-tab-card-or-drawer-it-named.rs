//! WHY: the sweep in `an-interaction-changes-the-state-and-reaches-the-host.rs`
//! proves every intent does something. It cannot see that the something is
//! the wrong thing: a tab index clamped to a neighbour, a stale card position
//! removing a card the operator did not answer, a closed drawer discarding
//! the output it held, an empty send handed to a host. This suite pins those
//! positions and counts.
//!
//! CLASS CLOSED: an intent that lands on a neighbour of the target it named,
//! and a shell-local effect that is reported to the host or a host effect
//! that is not. Also the order the host receives decisions in.
//!
//! NOT CAUGHT: a control wired to the wrong intent, which is the render side
//! in `every-control-the-operator-can-see-is-one-the-frame-will-answer.rs`.

mod support;

use support::{send, state};
use veyyon_desktop_surface::{Card, Intent, PanelTab, composer::TurnPhase, intent::Intents};

#[test]
fn opening_a_session_requests_the_host_without_replacing_confirmed_selection() {
	let mut state = state();
	let before = state.clone();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectSession(11), &mut state);

	assert_eq!(state.current_id, before.current_id, "selection awaits host acknowledgement");
	assert_eq!(state.title, before.title, "a failed request cannot replace the title");
	assert_eq!(
		intents.pending(),
		[Intent::SelectSession(11)],
		"the host was never asked for the opened session's transcript"
	);
}

#[test]
fn opening_a_session_that_is_not_in_the_queue_keeps_the_title_it_had() {
	let mut state = state();
	let before = state.current_id;
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectSession(404), &mut state);

	assert_eq!(
		state.current_id, before,
		"an unknown session does not replace the confirmed selection"
	);
	assert_eq!(
		state.title, "first",
		"a session with no row invented a title instead of keeping the last one"
	);
}

#[test]
fn a_tab_the_panel_does_not_offer_is_dropped_rather_than_taken() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectTab(PanelTab::Tree), &mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::Tree,
		"the tab that was clicked did not become active"
	);

	// The active tab is moved off the last one first. Dropping an unoffered
	// tab and falling back to the last offered one are indistinguishable while
	// the active tab already is that fallback, which is the shape a suite
	// passes for the wrong reason in.
	intents.dispatch(Intent::SelectTab(PanelTab::File), &mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::File,
		"the tab that was clicked did not become active"
	);

	// `Usage` is not in this panel's tab list, so no click can reach it.
	intents.dispatch(Intent::SelectTab(PanelTab::Usage), &mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::File,
		"a tab the panel does not offer became active"
	);

	// The selection is window state; what the tab draws is the host's, so the
	// intent is reported for the domain behind it to be re-stated.
	assert_eq!(
		intents.drain(),
		vec![
			Intent::SelectTab(PanelTab::Tree),
			Intent::SelectTab(PanelTab::File),
			Intent::SelectTab(PanelTab::Usage),
		],
		"a tab selection was not reported for the domain it draws to be re-stated"
	);
}

#[test]
fn the_drawer_opens_through_the_host_and_closes_alone_keeping_the_output_it_had() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SetDrawer { open: true }, &mut state);
	assert!(state.drawer_open, "the drawer did not open");
	assert_eq!(
		intents.drain(),
		[Intent::SetDrawer { open: true }],
		"the pane is the host's terminal, so opening it is the host's to answer"
	);

	intents.dispatch(Intent::SetDrawer { open: false }, &mut state);
	assert!(!state.drawer_open, "the drawer did not close again");
	assert!(intents.pending().is_empty(), "closing the drawer is the window's own business");
	assert!(
		!state.drawer.grid_rows.is_empty(),
		"closing the drawer discarded the output, so reopening it shows an empty pane"
	);
}

#[test]
fn answering_a_card_removes_that_card_and_leaves_the_rest_in_place() {
	let mut state = state();
	let mut intents = Intents::new();
	let answered = Intent::Answer { card: 1, option: 0 };

	intents.dispatch(answered.clone(), &mut state);

	assert_eq!(state.cards.len(), 2, "the answered card was not taken off the stack");
	assert!(
		matches!(state.cards.first(), Some(Card::Approval { .. })),
		"answering the middle card removed the wrong one"
	);
	assert!(
		matches!(state.cards.get(1), Some(Card::Plan { .. })),
		"answering the middle card removed the wrong one"
	);
	assert_eq!(intents.pending(), [answered], "the answer never reached the host");
}

#[test]
fn answering_a_card_position_that_no_longer_exists_removes_nothing() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::Approval { card: 9, approved: true, standing: false }, &mut state);

	assert_eq!(
		state.cards.len(),
		3,
		"a stale card position removed a card the operator did not answer"
	);
}

#[test]
fn an_empty_send_changes_nothing_and_is_never_reported() {
	let mut intents = Intents::new();

	for text in ["", "   ", "\t\n"] {
		let mut state = state();
		state.turn = TurnPhase::Idle;

		intents.dispatch(send(text), &mut state);

		assert_eq!(state.turn, TurnPhase::Idle, "an empty send modified turn phase anyway");
		assert!(
			intents.pending().is_empty(),
			"an empty send was handed to a host, which has no answer for it"
		);
	}
}

#[test]
fn a_send_preserves_host_turn_phase_and_is_drained_in_submission_order() {
	let mut state = state();
	state.turn = TurnPhase::Idle;
	let mut intents = Intents::new();

	intents.dispatch(send("ship it"), &mut state);
	intents.dispatch(Intent::SelectSession(9), &mut state);

	assert_eq!(
		state.turn,
		TurnPhase::Idle,
		"a request attempt changed the host-confirmed turn phase"
	);

	let drained = intents.drain();
	assert_eq!(
		drained,
		[send("ship it"), Intent::SelectSession(9)],
		"the host received the operator's decisions out of order"
	);
	assert!(
		intents.pending().is_empty(),
		"a drained intent is still pending, so the host will be told twice"
	);
}
