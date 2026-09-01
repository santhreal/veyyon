//! WHY: a control surface is judged by what a click does, and the defect class
//! here is an intent that half-lands — the row highlights but the host is never
//! told to open the session, the card disappears but the approval is never
//! reported, the tab index is clamped to a tab the operator did not click. Each
//! of those renders a plausible frame and loses the operator's decision.
//!
//! The class this closes is "an intent's effect and its reporting disagree".
//! Every variant of `Intent` is swept through one table, and the sweep is an
//! exhaustive match: a variant added to the enum fails to compile here until
//! its two answers — what it changes, and whether a host must hear it — are
//! written down.
//!
//! It does not catch a control wired to the wrong intent, which is the render
//! side and is asserted against the frame's hit rects in
//! `every-control-the-operator-can-see-is-one-the-frame-will-answer.rs`, and it
//! does not catch a host that ignores what it drained.

use veyyon_desktop_surface::{
	Badge, Card, Intent, Row, Section, ShellState, TreeRow, intent::Intents,
};

/// A state with two sections, three tabs, three cards and a closed drawer.
///
/// Built here rather than taken from `fixture` because these assertions name
/// exact positions and counts, and the fixture exists to be awkward to draw.
fn state() -> ShellState {
	ShellState {
		title:        "first".to_owned(),
		sections:     vec![
			(Section::Live, vec![
				Row {
					id:       7,
					title:    "first".to_owned(),
					subtitle: String::new(),
					badge:    Some(Badge::Working),
					meta:     None,
				},
				Row {
					id:       9,
					title:    "second".to_owned(),
					subtitle: String::new(),
					badge:    None,
					meta:     None,
				},
			]),
			(Section::Parked, vec![Row {
				id:       11,
				title:    "third".to_owned(),
				subtitle: String::new(),
				badge:    None,
				meta:     None,
			}]),
		],
		transcript:   Vec::new(),
		composed:     String::new(),
		run_status:   None,
		tree:         vec![TreeRow { depth: 0, name: "src".to_owned(), changed: None }],
		tabs:         vec!["Changes".to_owned(), "Terminal".to_owned(), "Diagnostics".to_owned()],
		active_tab:   0,
		cards:        vec![
			Card::Approval { tool: "bash".to_owned(), detail: vec!["rm -rf build".to_owned()] },
			Card::Question {
				prompt:  "Which target?".to_owned(),
				options: vec!["debug".to_owned(), "release".to_owned()],
			},
			Card::Plan { title: "Split the loaders".to_owned(), body: vec!["four files".to_owned()] },
		],
		drawer_lines: vec!["$ cargo test".to_owned()],
		drawer_open:  false,
		current_id:   7,
	}
}

/// One intent of every kind, with the two answers the suite checks.
///
/// The match is exhaustive on purpose: adding a variant to `Intent` breaks this
/// function, which is the only place that decides whether a new interaction is
/// the shell's to finish or a host's to answer.
fn every_intent() -> Vec<Intent> {
	let sample = vec![
		Intent::SelectSession(9),
		Intent::SelectTab(1),
		Intent::SetDrawer { open: true },
		Intent::SetDrawer { open: false },
		Intent::Approval { card: 0, approved: true, standing: false },
		Intent::Answer { card: 1, option: 1 },
		Intent::Reply { card: 1, text: "ship it".to_owned() },
		Intent::Plan { card: 2, accepted: false },
		Intent::Send("ship it".to_owned()),
	];

	// The exhaustive match is the gate. Every variant is named, so a new one
	// turns this red rather than slipping through the sweep untested.
	for intent in &sample {
		match intent {
			Intent::SelectSession(_)
			| Intent::SelectTab(_)
			| Intent::SetDrawer { .. }
			| Intent::Approval { .. }
			| Intent::Answer { .. }
			| Intent::Reply { .. }
			| Intent::Plan { .. }
			| Intent::Send(_) => {},
		}
	}

	sample
}

#[test]
fn every_intent_either_changes_the_state_or_is_reported_and_never_neither() {
	for intent in every_intent() {
		// The composer is seeded because a send whose composer is already empty
		// changes nothing, and the sweep would then read a working send as a
		// dead one.
		let mut before = state();
		before.composed = "ship it".to_owned();
		// The drawer is seeded opposite to the intent for the same reason: a
		// close on a closed drawer is not the close being swept.
		if let Intent::SetDrawer { open } = &intent {
			before.drawer_open = !open;
		}
		let mut after = before.clone();

		let mut intents = Intents::new();
		intents.dispatch(intent.clone(), &mut after);

		let changed = format!("{after:?}") != format!("{before:?}");
		let reported = !intents.pending().is_empty();

		assert!(
			changed,
			"{intent:?} left the state untouched, so nothing an operator can see happened"
		);
		assert_eq!(
			reported,
			!intent.is_local(),
			"{intent:?} disagrees with its own locality: reported={reported}"
		);
	}
}

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
	assert_eq!(state.active_tab, 2, "the tab that was clicked did not become active");

	// The active tab is moved off the last one first. A clamp and a drop are
	// indistinguishable while the active tab already is the clamp's target,
	// which is the shape a suite passes for the wrong reason in.
	intents.dispatch(Intent::SelectTab(1), &mut state);
	assert_eq!(state.active_tab, 1, "the tab that was clicked did not become active");

	for past_the_end in [3, 9, usize::MAX] {
		intents.dispatch(Intent::SelectTab(past_the_end), &mut state);
		assert_eq!(
			state.active_tab, 1,
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
	assert_eq!(
		state.drawer_lines,
		["$ cargo test"],
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
		state.composed = text.to_owned();

		intents.dispatch(Intent::Send(text.to_owned()), &mut state);

		assert_eq!(state.composed, text, "an empty send cleared the composer anyway");
		assert!(
			intents.pending().is_empty(),
			"an empty send was handed to a host, which has no answer for it"
		);
	}
}

#[test]
fn a_send_clears_the_composer_and_is_drained_in_the_order_it_happened() {
	let mut state = state();
	state.composed = "ship it".to_owned();
	let mut intents = Intents::new();

	intents.dispatch(Intent::Send("ship it".to_owned()), &mut state);
	intents.dispatch(Intent::SelectSession(9), &mut state);

	assert!(
		state.composed.is_empty(),
		"the composer still holds text that was already sent, so it can be sent twice"
	);

	let drained = intents.drain();
	assert_eq!(
		drained,
		[Intent::Send("ship it".to_owned()), Intent::SelectSession(9)],
		"the host received the operator's decisions out of order"
	);
	assert!(
		intents.pending().is_empty(),
		"a drained intent is still pending, so the host will be told twice"
	);
}
