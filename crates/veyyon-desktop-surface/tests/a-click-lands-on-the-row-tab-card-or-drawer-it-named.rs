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
use veyyon_desktop_surface::{
	Card, Intent, PanelTab,
	composer::{QueueMode, TurnPhase},
	intent::Intents,
};

#[test]
fn opening_a_session_moves_the_highlight_the_title_and_tells_the_host() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectSession(11), &mut state);

	assert_eq!(state.current_id, 11, "the queue still draws the previous row as open");
	assert_eq!(state.title, "third", "the titlebar still names the previous session");
	assert_eq!(
		intents.pending(),
		[Intent::SelectSession(11)],
		"the host was never asked for the opened session's transcript"
	);
}

#[test]
fn opening_a_session_that_is_not_in_the_queue_keeps_the_title_it_had() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectSession(404), &mut state);

	assert_eq!(state.current_id, 404, "the selection was refused rather than recorded");
	assert_eq!(
		state.title, "first",
		"a session with no row invented a title instead of keeping the last one"
	);
}

#[test]
fn a_tab_out_of_range_is_dropped_rather_than_clamped_to_a_neighbour() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectTab(2), &mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::Tree,
		"the tab that was clicked did not become active"
	);

	// The active tab is moved off the last one first. A clamp and a drop are
	// indistinguishable while the active tab already is the clamp's target,
	// which is the shape a suite passes for the wrong reason in.
	intents.dispatch(Intent::SelectTab(1), &mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::File,
		"the tab that was clicked did not become active"
	);

	for past_the_end in [3, 9, usize::MAX] {
		intents.dispatch(Intent::SelectTab(past_the_end), &mut state);
		assert_eq!(
			state.panel.active_tab,
			PanelTab::File,
			"tab {past_the_end} past the last one moved the panel to a tab nobody clicked"
		);
	}

	assert!(
		intents.pending().is_empty(),
		"switching a tab is the window's own business and was reported to a host"
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
fn a_send_transitions_turn_phase_and_is_drained_in_the_order_it_happened() {
	let mut state = state();
	state.turn = TurnPhase::Idle;
	let mut intents = Intents::new();

	intents.dispatch(send("ship it"), &mut state);
	intents.dispatch(Intent::SelectSession(9), &mut state);

	assert_eq!(
		state.turn,
		TurnPhase::Running { queue_mode: QueueMode::Steer },
		"send did not transition to running turn phase"
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
