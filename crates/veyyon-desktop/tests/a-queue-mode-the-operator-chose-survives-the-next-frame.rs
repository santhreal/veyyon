//! WHY: `primary-/` toggles whether a prompt sent during a turn steers it or
//! queues behind it. The chord reached the shell and set the mode, and then the
//! next projection took it straight back: `project_turn_phase` and
//! `project_composer` re-derived the mode from `Store::composer_drafts`, a map
//! no host frame ever writes, so the mode reverted to `Steer` on the first
//! frame the running turn produced — which, mid-stream, is within a frame of
//! the keypress.
//!
//! CLASS CLOSED: window-owned composer state re-derived, on every frame, from
//! host state that nothing populates, and a chord that reaches past the
//! availability its own control reads. The suite drives the shipped chord
//! through a real window and then runs the projection the way a streaming
//! frame does, so any client-owned composer field that a projection overwrites
//! fails here, as does a keybinding that dispatches an intent the pointer path
//! would refuse. `every_field_the_window_owns_survives_the_frame` names each
//! field of `ComposerState` without `..`, so adding one is a compile error
//! until someone records which side owns it.
//!
//! §5.4 authors one up arrow for every turn state: the mode changes what the
//! control does and what it is called, never its shape. So the chord's effect
//! is asserted on the state, the action and the accessible name, and the frame
//! is asserted NOT to move — a reintroduced glyph morph fails here.
//!
//! GAPS: it does not prove the host acts on the mode — that a queued prompt is
//! delivered as `FollowUp` is `packages/coding-agent/test/gui-host`'s contract
//! — and it says nothing about how the name reads on hover, which is a
//! capture's business.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, fields::driven_with_keys, session};
use veyyon_desktop::{SessionIndex, project, project_controls, project_turn_phase};
use veyyon_desktop_model::{
	BadgeKind, Capability, CapabilityStatus, ConnectionState, PROTOCOL_VERSION, QueueMode,
	QueuePartition, RequestRegistry, SessionId, Store,
};
use veyyon_desktop_surface::{
	Intent, ShellState,
	composer::{ComposerState, PrimaryAction, TurnPhase, primary_action},
};

/// A store holding one open session whose turn is streaming, which is the only
/// state in which the mode is anything but decoration.
fn streaming_store() -> (Store, SessionId) {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id.clone());
	// Attached, or the window draws the connection screen and there is no
	// composer to press a chord at.
	store.connection = ConnectionState::Connected {
		endpoint: "unix:/run/veyyon.sock".to_owned(),
		protocol: PROTOCOL_VERSION,
	};
	store
		.capabilities
		.set(Capability::TurnControl, CapabilityStatus::Available);
	store
		.capabilities
		.set(Capability::BackgroundSubmission, CapabilityStatus::Available);
	support::seed_badge(&mut store, "s1", BadgeKind::Working);
	(store, id)
}

/// One host frame, projected the way the shell projects one: the store's own
/// fields and then the availability every control reads, which is what a chord
/// consults before it dispatches.
fn frame_of(store: &Store, state: &mut ShellState) {
	let mut index = SessionIndex::new();
	project(store, &mut index, &HashMap::new(), NOW_MS, state);
	project_controls(store, &RequestRegistry::new(), &index, state);
}

#[test]
fn the_chord_flips_the_mode_and_the_next_frame_leaves_it_alone() {
	let (store, id) = streaming_store();
	let mut state = ShellState::default();
	frame_of(&store, &mut state);
	assert_eq!(
		state.turn,
		TurnPhase::Running { queue_mode: QueueMode::Steer },
		"a streaming session opens in the mode that steers"
	);

	let (after_chord, intents, unmoved) = driven_with_keys(state, |session| {
		let before = session
			.frame()
			.expect("the composer draws in steer mode")
			.frame
			.as_bytes()
			.to_vec();
		// The first frame focuses the composer's editor, which is what puts the
		// composer's key context on the focus path (§5.14).
		let handled = session.keystroke("ctrl-/").expect("the chord dispatches");
		assert!(handled, "the shipped table binds primary-/ inside the composer");
		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("what the chord raised");
		let after = session
			.frame()
			.expect("the composer draws in queue mode")
			.frame
			.as_bytes()
			.to_vec();
		let state = session
			.update(|view, _window, _cx| view.state().clone())
			.expect("the state the chord left");
		(state, intents, before == after)
	});

	assert!(
		intents.contains(&Intent::SetQueueMode(QueueMode::Queue)),
		"the host is told which mode the operator chose: {intents:?}"
	);
	assert_eq!(after_chord.composer.queue_mode, QueueMode::Queue);
	assert_eq!(after_chord.turn, TurnPhase::Running { queue_mode: QueueMode::Queue });
	assert_eq!(
		primary_action(&after_chord.turn, false).0,
		PrimaryAction::Queue,
		"the primary action follows the mode"
	);
	assert_eq!(
		primary_action(&after_chord.turn, false).0.label(),
		"Queue message",
		"and the control is called what pressing it now does (§5.4)"
	);
	assert!(
		unmoved,
		"§5.4 authors one up arrow for every turn state: the mode changes the action and its name, \
		 so the frame is the same bytes on both sides of the chord"
	);

	// The frame that follows: the turn is still streaming, so the host reports
	// again within milliseconds. Nothing about that frame is the mode's.
	let mut next = after_chord;
	frame_of(&store, &mut next);
	assert_eq!(
		next.composer.queue_mode,
		QueueMode::Queue,
		"the frame that follows the chord does not undo it"
	);
	assert_eq!(next.turn, TurnPhase::Running { queue_mode: QueueMode::Queue });
	assert_eq!(
		project_turn_phase(&store, Some(&id), QueueMode::Queue),
		TurnPhase::Running { queue_mode: QueueMode::Queue },
		"the phase carries the mode it was given"
	);
}

#[test]
fn a_transport_that_cannot_carry_a_queued_prompt_leaves_one_mode() {
	let (mut store, id) = streaming_store();
	store
		.capabilities
		.set(Capability::BackgroundSubmission, CapabilityStatus::Unavailable {
			reason: "the host runs one turn at a time".to_owned(),
		});

	let mut state = ShellState::default();
	state.composer.queue_mode = QueueMode::Queue;
	frame_of(&store, &mut state);
	assert_eq!(
		state.composer.queue_mode,
		QueueMode::Steer,
		"a mode the transport cannot carry is not offered"
	);
	assert_eq!(
		state.turn,
		TurnPhase::Running { queue_mode: QueueMode::Steer },
		"and the phase states the mode a prompt would actually take"
	);
	assert_eq!(
		project_turn_phase(&store, Some(&id), QueueMode::Queue),
		TurnPhase::Running { queue_mode: QueueMode::Steer },
		"the clamp is the projection's, not the caller's"
	);
}

#[test]
fn the_chord_is_refused_where_the_toggle_itself_is() {
	let (mut store, _) = streaming_store();
	store
		.capabilities
		.set(Capability::BackgroundSubmission, CapabilityStatus::Unavailable {
			reason: "the host runs one turn at a time".to_owned(),
		});

	let mut state = ShellState::default();
	frame_of(&store, &mut state);

	let (after_chord, intents) = driven_with_keys(state, |session| {
		// The frame comes first because it is what focuses the composer's
		// editor, which is what puts the composer's key context on the focus
		// path (§5.14).
		session.frame().expect("the composer draws with one mode");
		let handled = session.keystroke("ctrl-/").expect("the chord dispatches");
		assert!(handled, "the binding is still on the focus path");
		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("what the chord raised");
		let state = session
			.update(|view, _window, _cx| view.state().clone())
			.expect("the state the chord left");
		(state, intents)
	});

	assert!(
		!intents
			.iter()
			.any(|intent| matches!(intent, Intent::SetQueueMode(_))),
		"a chord is refused where the control it drives is, rather than sending the host a request \
		 it rejects: {intents:?}"
	);
	assert_eq!(
		after_chord.composer.queue_mode,
		QueueMode::Steer,
		"and the mode the operator can act on is the one still drawn"
	);
	assert_eq!(after_chord.turn, TurnPhase::Running { queue_mode: QueueMode::Steer });
	assert_eq!(
		primary_action(&after_chord.turn, false).0.label(),
		"Steer turn",
		"and the name still states the only action the transport carries"
	);
}

#[test]
fn every_field_the_window_owns_survives_the_frame() {
	let (store, _id) = streaming_store();

	// Named without `..`: a new field of ComposerState fails to compile here
	// until it is decided whose the field is.
	let mut state = ShellState {
		composer: ComposerState {
			model:       None,
			thinking:    None,
			queue_mode:  QueueMode::Queue,
			attachments: Vec::new(),
			context:     None,
			queued:      vec!["a prompt the host is not holding".to_string()],
		},
		..ShellState::default()
	};

	frame_of(&store, &mut state);
	assert_eq!(
		state.composer.queue_mode,
		QueueMode::Queue,
		"the queue mode is the window's; no host frame reports one"
	);

	// The host's fields are the host's: an empty store empties them rather
	// than leaving a stale model or meter on the footer.
	assert!(state.composer.model.is_none(), "no models view, no model control");
	assert!(state.composer.thinking.is_none(), "no levels, no thinking control");
	assert!(state.composer.context.is_none(), "no breakdown, no meter");
	assert!(
		state.composer.queued.is_empty(),
		"the held prompts are the host's; a session holding none holds none on the strip"
	);
}
