//! WHY: When the operator clicks take-back or presses Alt+Up, the raised
//! `Intent::DequeueQueuedPrompt` must be translated into the corresponding
//! `HostAction::DequeueQueuedPrompt` for the open session.
//!
//! CLASS CLOSED: Unmapped `DequeueQueuedPrompt` intents or actions dispatched
//! without an active session.

mod support;

use support::session;
use veyyon_desktop::{
	SessionIndex, actions_for,
	project::{project_composer, restored_draft},
};
use veyyon_desktop_model::{
	HostAction, QueuePartition, QueuedPrompts, QueuedPromptsView, SessionId, Store,
};
use veyyon_desktop_surface::{ComposerState, Intent};

#[test]
fn dequeue_intent_maps_to_host_action_for_active_session() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-1");
	store
		.sessions
		.insert(session("sess-1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());

	let index = SessionIndex::new();

	let actions = actions_for(&Intent::DequeueQueuedPrompt, &index, &mut store);
	assert_eq!(
		actions,
		vec![HostAction::DequeueQueuedPrompt { session: session_id }],
		"DequeueQueuedPrompt intent must produce exactly one DequeueQueuedPrompt action for the \
		 active session"
	);

	// With no active session, no action is produced
	store.persisted.shell.active_session = None;
	let empty_actions = actions_for(&Intent::DequeueQueuedPrompt, &index, &mut store);
	assert!(
		empty_actions.is_empty(),
		"DequeueQueuedPrompt intent without active session must produce no action"
	);
}

#[test]
fn project_composer_populates_queued_prompts_in_delivery_order() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-1");
	store
		.sessions
		.insert(session("sess-1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());

	store.queued.insert(session_id.clone(), QueuedPrompts {
		steering:  vec!["steering one".to_string(), "steering two".to_string()],
		follow_up: vec!["follow-up one".to_string()],
	});

	let mut composer = ComposerState::default();
	project_composer(&store, Some(&session_id), &mut composer);

	assert_eq!(
		composer.queued,
		vec!["steering one", "steering two", "follow-up one"],
		"project_composer must fill composer.queued in delivery order (steering before follow_up)"
	);

	// Clearing queued store clears composer.queued
	store.queued.remove(&session_id);
	project_composer(&store, Some(&session_id), &mut composer);
	assert!(
		composer.queued.is_empty(),
		"project_composer must clear composer.queued when store holds nothing"
	);
}

/// The take-back answer belongs to the composer that asked for it: the window
/// draws one, so a frame for a session the operator has since left must not
/// overwrite the draft in front of them.
#[test]
fn a_taken_back_prompt_reaches_only_the_composer_that_is_drawn() {
	let mut index = SessionIndex::new();
	let drawn = SessionId::from("sess-1");
	let other = SessionId::from("sess-2");
	let drawn_row = index.row_of(&drawn);
	let other_row = index.row_of(&other);
	assert_ne!(drawn_row, other_row, "two sessions hold two rows");

	let answer = |session: &SessionId| QueuedPromptsView {
		session:   session.clone(),
		steering:  Vec::new(),
		follow_up: Vec::new(),
		restored:  Some("the prompt taken back".to_string()),
	};

	assert_eq!(
		restored_draft(&index, drawn_row, &answer(&drawn)),
		Some("the prompt taken back"),
		"the drawn session's answer reaches its own composer"
	);
	assert_eq!(
		restored_draft(&index, drawn_row, &answer(&other)),
		None,
		"another session's answer must not land in the drawn draft"
	);
	assert_eq!(
		restored_draft(&index, 0, &answer(&drawn)),
		None,
		"with no session open there is no draft to hand text back to"
	);

	// A frame that reports held prompts without answering a dequeue hands
	// nothing back, so an ordinary queue update never clears what is typed.
	let report = QueuedPromptsView {
		session:   drawn.clone(),
		steering:  vec!["still held".to_string()],
		follow_up: Vec::new(),
		restored:  None,
	};
	assert_eq!(
		restored_draft(&index, drawn_row, &report),
		None,
		"a queue report is not an answer; the draft is the operator's"
	);
}
