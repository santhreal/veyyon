//! WHY THIS SUITE EXISTS
//!
//! Autonomous goal mode actions (`SetGoal`, `ControlGoal`) must bridge accurately
//! from surface `Intent` values to host protocol `HostAction` requests. When the
//! host's `Goals` capability is unavailable (e.g. `goal.enabled` setting is off),
//! the goal controls on the attached card must be drawn as disabled capability
//! gates rather than dispatching refused actions across the wire.
//!
//! THE CLASS THIS CLOSES:
//! 1. An intent (`SetGoal`, `ControlGoal`) failing to map to the corresponding
//!    host protocol request or dropping its fields (objective, budget, op).
//! 2. Goal card controls attempting to dispatch when `Goals` capability is declined.
//! 3. Client-side goal card toggle failing to show/hide the card without a host round-trip.
//!
//! WHAT IT DOES NOT CATCH:
//! Pixel-level GTK/GPUI rendering; host-side JSON-RPC transport encoding.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, actions_for, project, project_controls};
use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, GoalControl, GoalStatus, GoalView, HostAction,
	PROTOCOL_VERSION, QueuePartition, RequestRegistry, SessionId, Store,
};
use veyyon_desktop_surface::{
	Card, Intent, ShellState,
	controls::{Availability, availability_style},
};

fn sample_goal_view(status: GoalStatus) -> GoalView {
	GoalView {
		objective: "Implement autonomous test loops".to_string(),
		status,
		driving: matches!(status, GoalStatus::Active),
		tokens_used: 15_000,
		token_budget: Some(50_000),
		turns_completed: 2,
		time_used_seconds: 180,
		created_at_ms: NOW_MS - 180_000,
		updated_at_ms: NOW_MS,
		stood_down: None,
	}
}

#[test]
fn goal_intents_map_accurately_to_host_actions() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-goal-1");
	store
		.sessions
		.insert(session(session_id.0.as_str(), QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());

	let index = SessionIndex::new();

	// 1. SetGoal with budget
	let set_intent = Intent::SetGoal {
		objective: "Build parity features".to_string(),
		token_budget: Some(80_000),
	};
	let actions = actions_for(&set_intent, &index, &mut store);
	assert_eq!(
		actions,
		vec![HostAction::SetGoal {
			session: session_id.clone(),
			objective: "Build parity features".to_string(),
			token_budget: Some(80_000),
		}],
		"SetGoal intent must map to HostAction::SetGoal carrying session and budget"
	);

	// 2. SetGoal without budget (unbounded)
	let set_unbounded = Intent::SetGoal {
		objective: "Unbounded exploration".to_string(),
		token_budget: None,
	};
	let actions = actions_for(&set_unbounded, &index, &mut store);
	assert_eq!(
		actions,
		vec![HostAction::SetGoal {
			session: session_id.clone(),
			objective: "Unbounded exploration".to_string(),
			token_budget: None,
		}]
	);

	// 3. ControlGoal: Pause
	let pause_intent = Intent::ControlGoal { op: GoalControl::Pause };
	let actions = actions_for(&pause_intent, &index, &mut store);
	assert_eq!(
		actions,
		vec![HostAction::ControlGoal {
			session: session_id.clone(),
			op: GoalControl::Pause,
		}]
	);

	// 4. ControlGoal: Resume
	let resume_intent = Intent::ControlGoal { op: GoalControl::Resume };
	let actions = actions_for(&resume_intent, &index, &mut store);
	assert_eq!(
		actions,
		vec![HostAction::ControlGoal {
			session: session_id.clone(),
			op: GoalControl::Resume,
		}]
	);

	// 5. ControlGoal: Drop
	let drop_intent = Intent::ControlGoal { op: GoalControl::Drop };
	let actions = actions_for(&drop_intent, &index, &mut store);
	assert_eq!(
		actions,
		vec![HostAction::ControlGoal {
			session: session_id,
			op: GoalControl::Drop,
		}]
	);

	// 6. ToggleGoalCard is purely client-side; produces zero host actions
	let toggle_intent = Intent::ToggleGoalCard;
	assert!(
		toggle_intent.is_local(),
		"ToggleGoalCard must be marked as a local intent"
	);
	let actions = actions_for(&toggle_intent, &index, &mut store);
	assert!(
		actions.is_empty(),
		"ToggleGoalCard must produce no host actions across the wire"
	);

	// 7. Actions with no active session return empty
	store.persisted.shell.active_session = None;
	let actions_no_session = actions_for(&pause_intent, &index, &mut store);
	assert!(
		actions_no_session.is_empty(),
		"Goal actions with no active session must produce no host actions"
	);
}

#[test]
fn goals_capability_declined_draws_controls_as_gates() {
	let mut store = Store::new();
	store.connection = ConnectionState::Connected {
		endpoint: "127.0.0.1:47000".to_string(),
		protocol: PROTOCOL_VERSION,
	};
	let session_id = SessionId::from("sess-gate-1");
	store
		.sessions
		.insert(session(session_id.0.as_str(), QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());

	let goal_view = sample_goal_view(GoalStatus::Active);
	store.goals.insert(session_id, goal_view.clone());

	let mut index = SessionIndex::new();
	let registry = RequestRegistry::new();
	let tokens = TokenSet::default();
	let mut state = ShellState::default();

	// --- Case A: Goals capability is Available ---
	store
		.capabilities
		.set(Capability::Goals, CapabilityStatus::Available);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	project_controls(&store, &registry, &index, &mut state);

	assert_eq!(
		state.goal,
		Some(goal_view.clone()),
		"active session goal must project to state.goal"
	);
	assert_eq!(
		state.composer.goal,
		Some(goal_view.clone()),
		"active session goal must project to state.composer.goal"
	);

	assert_eq!(
		state.card_answers.goals,
		Availability::Enabled,
		"when Goals capability is Available, card_answers.goals must be Enabled"
	);

	let goal_card = Card::Goal { view: goal_view };
	assert_eq!(
		state.card_answers.of(&goal_card),
		&Availability::Enabled,
		"CardAnswers::of for Goal card must resolve to Enabled"
	);

	let (_opacity, _cursor, activatable) =
		availability_style(&state.card_answers.goals, &tokens);
	assert!(
		activatable,
		"controls must be activatable when Goals capability is available"
	);

	// --- Case B: Goals capability is Unavailable (declined by host) ---
	let decline_reason = "goal mode disabled in settings";
	store.capabilities.set(
		Capability::Goals,
		CapabilityStatus::Unavailable { reason: decline_reason.to_string() },
	);
	project_controls(&store, &registry, &index, &mut state);

	assert_eq!(
		state.card_answers.goals,
		Availability::Unavailable { reason: decline_reason.to_string() },
		"when Goals capability is declined, card_answers.goals must be Unavailable"
	);
	assert_eq!(
		state.card_answers.of(&goal_card),
		&Availability::Unavailable { reason: decline_reason.to_string() },
		"CardAnswers::of for Goal card must be Unavailable when capability is declined"
	);

	let (_opacity, _cursor, activatable_declined) =
		availability_style(&state.card_answers.goals, &tokens);
	assert!(
		!activatable_declined,
		"controls must NOT be activatable when Goals capability is declined (drawn as gate)"
	);
}

#[test]
fn goal_card_toggles_open_and_closed_client_side() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-toggle-1");
	store
		.sessions
		.insert(session(session_id.0.as_str(), QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());

	let goal_view = sample_goal_view(GoalStatus::Active);
	store.goals.insert(session_id, goal_view.clone());

	let mut index = SessionIndex::new();
	let mut state = ShellState::default();

	// Project from store
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	// Initially, card is closed: goal is known on state, but cards does not hold Card::Goal
	assert!(!state.goal_card_open, "goal card must start closed");
	assert!(
		state.cards.iter().all(|c| !matches!(c, Card::Goal { .. })),
		"closed goal card must not be in state.cards"
	);

	// First toggle: opens the card
	state.goal_card_open = true;
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert!(state.goal_card_open);
	assert!(
		state.cards.iter().any(|c| matches!(c, Card::Goal { view } if view == &goal_view)),
		"open goal card must be present in state.cards with matching view"
	);

	// Second toggle: closes the card
	state.goal_card_open = false;
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert!(!state.goal_card_open);
	assert!(
		state.cards.iter().all(|c| !matches!(c, Card::Goal { .. })),
		"toggled-closed goal card must be removed from state.cards"
	);
}
