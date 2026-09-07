//! WHY: `primary-/` toggles whether a prompt sent during a turn steers it or
//! queues behind it. The chord reached the shell and set the mode, and then the
//! next projection took it straight back: `project_turn_phase` and
//! `project_composer` re-derived the mode from `Store::composer_drafts`, a map
//! no host frame ever writes, so the mode reverted to `Steer` on the first
//! frame the running turn produced — which, mid-stream, is within a frame of
//! the keypress. On a native capture of a real running turn the composer drew
//! the same up-arrow before and after the chord.
//!
//! CLASS CLOSED: window-owned composer state re-derived, on every frame, from
//! host state that nothing populates. The suite drives the shipped chord
//! through a real window and then runs the projection the way a streaming
//! frame does, so any client-owned composer field that a projection overwrites
//! fails here. `every_field_the_window_owns_survives_the_frame` names each
//! field of `ComposerState` without `..`, so adding one is a compile error
//! until someone records which side owns it.
//!
//! GAPS: it does not prove the host acts on the mode — that a queued prompt is
//! delivered as `FollowUp` is `packages/coding-agent/test/gui-host`'s contract
//! — and it says nothing about how the two modes read, which is a capture's
//! business.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, fields::driven_with_keys, session};
use veyyon_desktop::{SessionIndex, project, project_turn_phase};
use veyyon_desktop_model::{
	BadgeKind, Capability, CapabilityStatus, ConnectionState, PROTOCOL_VERSION, QueueMode,
	QueuePartition, SessionId, Store,
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
		.set(Capability::BackgroundSubmission, CapabilityStatus::Available);
	support::seed_badge(&mut store, "s1", BadgeKind::Working);
	(store, id)
}

fn frame_of(store: &Store, state: &mut ShellState) {
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, state);
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

	let (after_chord, intents, differed) = driven_with_keys(state, |session| {
		let before = session
			.frame()
			.expect("the composer draws in steer mode")
			.frame
			.as_bytes()
			.to_vec();
		// The first frame focuses the composer's editor, which is what puts the
		// composer's key context on the focus path (§5.14).
		let handled = session
			.keystroke("ctrl-/")
			.expect("the chord dispatches");
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
		(state, intents, before != after)
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
	assert!(differed, "the chord changes what the composer draws");

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
	store.capabilities.set(
		Capability::BackgroundSubmission,
		CapabilityStatus::Unavailable { reason: "the host runs one turn at a time".to_owned() },
	);

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
fn every_field_the_window_owns_survives_the_frame() {
	let (store, _id) = streaming_store();

	// Named without `..`: a new field of ComposerState fails to compile here
	// until it is decided whose the field is.
	let mut state = ShellState::default();
	state.composer = ComposerState {
		model:       None,
		thinking:    None,
		queue_mode:  QueueMode::Queue,
		attachments: Vec::new(),
		context:     None,
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
}
