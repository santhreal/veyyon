//! WHY: The turn phase determines which primary action is presented to the
//! operator. The defect class closed here is a projection divergence where
//! active streaming, pending approvals, user questions, or proposed plans fail
//! to project onto the matching `TurnPhase` on `ShellState`.
//!
//! The suite defends:
//! 1. An idle session with no active streams or decisions projects to
//!    `TurnPhase::Idle`.
//! 2. Active generation streams project to `TurnPhase::Running` respecting the
//!    draft's `QueueMode`.
//! 3. Pending approvals, questions, and plans take precedence over background
//!    streaming.
//! 4. Question option counts accurately project to `TurnPhase::QuestionPending
//!    { options }`.
//! 5. `project()` end-to-end sets `state.turn` on `ShellState`.
//!
//! Gap left: Does not assert remote WebSocket packet wire deserialization.

use std::collections::HashMap;

use veyyon_desktop::project::{SessionIndex, project, project_turn_phase};
use veyyon_desktop_model::{
	ApprovalInteraction, ComposerDraft, InteractionId, PendingDecisions, PlanInteraction,
	QuestionInteraction, QueueMode, QueuePartition, Session, SessionId, Store,
	StreamingMessageState,
};
use veyyon_desktop_surface::{ShellState, TurnPhase};

const NOW_MS: u64 = 1_700_000_000_000;

fn create_test_session(id: &str) -> Session {
	Session {
		id:                SessionId::from(id),
		title:             format!("Session {id}"),
		project_name:      "test".to_string(),
		branch:            "main".to_string(),
		partition:         QueuePartition::Live,
		badge:             None,
		created_at_ms:     NOW_MS,
		last_recall_at_ms: NOW_MS,
		defer_until_ms:    None,
		parked_at_ms:      None,
		pin_key:           None,
	}
}

#[test]
fn idle_phase_when_nothing_is_streaming_or_pending() {
	let mut store = Store::new();
	let session_id = SessionId::from("s1");
	store.sessions.insert(create_test_session("s1"));
	store.persisted.shell.active_session = Some(session_id.clone());

	let phase = project_turn_phase(&store, Some(&session_id));
	assert_eq!(phase, TurnPhase::Idle);

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.turn, TurnPhase::Idle);
}

#[test]
fn streaming_projects_to_running_with_configured_queue_mode() {
	let mut store = Store::new();
	let session_id = SessionId::from("s1");
	store.sessions.insert(create_test_session("s1"));
	store.persisted.shell.active_session = Some(session_id.clone());

	// Add streaming state
	store
		.streaming
		.insert(session_id.clone(), StreamingMessageState {
			entry:        veyyon_desktop_model::EntryId::from("e1"),
			tool:         None,
			accumulating: veyyon_desktop_model::TranscriptEntry {
				id:                veyyon_desktop_model::EntryId::from("e1"),
				parent:            None,
				revision:          1,
				timestamp_ms:      NOW_MS,
				role:              veyyon_desktop_model::MessageRole::Assistant,
				content:           Vec::new(),
				meta:              None,
				raw_discriminator: String::new(),
				raw:               serde_json::Value::Null,
			},
			revision:     1,
		});

	// Default without explicit composer draft -> Steer
	let phase = project_turn_phase(&store, Some(&session_id));
	assert_eq!(phase, TurnPhase::Running { queue_mode: QueueMode::Steer });

	// Explicit draft with Queue mode
	store
		.composer_drafts
		.insert(session_id.clone(), ComposerDraft {
			text:           String::new(),
			attachments:    Vec::new(),
			queue_mode:     QueueMode::Queue,
			selected_model: None,
			thinking_level: None,
		});

	let phase_queue = project_turn_phase(&store, Some(&session_id));
	assert_eq!(phase_queue, TurnPhase::Running { queue_mode: QueueMode::Queue });

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.turn, TurnPhase::Running { queue_mode: QueueMode::Queue });
}

#[test]
fn pending_decisions_take_precedence_over_active_streaming() {
	let mut store = Store::new();
	let session_id = SessionId::from("s1");
	store.sessions.insert(create_test_session("s1"));
	store.persisted.shell.active_session = Some(session_id.clone());

	// Streaming is active
	store
		.streaming
		.insert(session_id.clone(), StreamingMessageState {
			entry:        veyyon_desktop_model::EntryId::from("e1"),
			tool:         None,
			accumulating: veyyon_desktop_model::TranscriptEntry {
				id:                veyyon_desktop_model::EntryId::from("e1"),
				parent:            None,
				revision:          1,
				timestamp_ms:      NOW_MS,
				role:              veyyon_desktop_model::MessageRole::Assistant,
				content:           Vec::new(),
				meta:              None,
				raw_discriminator: String::new(),
				raw:               serde_json::Value::Null,
			},
			revision:     1,
		});

	// 1. Approval pending
	store
		.interactions
		.insert(session_id.clone(), PendingDecisions {
			approvals: vec![ApprovalInteraction {
				id:              InteractionId::from("a1"),
				tool_name:       "bash".to_string(),
				detail:          "rm -rf target".to_string(),
				requested_at_ms: NOW_MS,
			}],
			questions: Vec::new(),
			plans:     Vec::new(),
		});

	let phase_approval = project_turn_phase(&store, Some(&session_id));
	assert_eq!(phase_approval, TurnPhase::ApprovalPending);

	// 2. Question pending (clearing approvals)
	store
		.interactions
		.get_mut(&session_id)
		.unwrap()
		.approvals
		.clear();
	store.interactions.get_mut(&session_id).unwrap().questions = vec![QuestionInteraction {
		id:              InteractionId::from("q1"),
		prompt:          "Pick environment".to_string(),
		options:         vec!["Dev".to_string(), "Staging".to_string(), "Prod".to_string()],
		requested_at_ms: NOW_MS,
	}];

	let phase_question = project_turn_phase(&store, Some(&session_id));
	assert_eq!(phase_question, TurnPhase::QuestionPending { options: 3 });

	// 3. Plan pending (clearing questions)
	store
		.interactions
		.get_mut(&session_id)
		.unwrap()
		.questions
		.clear();
	store.interactions.get_mut(&session_id).unwrap().plans = vec![PlanInteraction {
		id:              InteractionId::from("p1"),
		markdown_plan:   "# Plan\nStep 1\nStep 2".to_string(),
		requested_at_ms: NOW_MS,
	}];

	let phase_plan = project_turn_phase(&store, Some(&session_id));
	assert_eq!(phase_plan, TurnPhase::PlanPending);

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.turn, TurnPhase::PlanPending);
}

#[test]
fn absent_active_session_projects_to_idle() {
	let store = Store::new();
	let phase = project_turn_phase(&store, None);
	assert_eq!(phase, TurnPhase::Idle);

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.turn, TurnPhase::Idle);
}
