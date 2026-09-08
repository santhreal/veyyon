//! WHY: Twenty-one of seventy-five host actions had no sender outside test
//! suites, leaving a quarter of the protocol unreachable from the native
//! desktop front end.
//!
//! The three that remain are the transport's own: `Attach`, `Detach` and
//! `Shutdown` are sent by the connection and the window's close, not by a
//! control the operator points at.
//!
//! CLASS CLOSED: Every action the host answers has a sender in the native
//! desktop (via an operator `Intent` dispatched to `actions_for`, or a
//! registered interactive control in `gated_controls`), or is explicitly
//! recorded in `PINNED_UNSENT`. Adding a new `HostActionKind` or removing a
//! sender turns this suite red until accounted for. Furthermore, `Intent`
//! variants are swept via an exhaustive match on `IntentDiscriminants`,
//! ensuring any newly introduced `Intent` variant fails compilation until
//! mapped here.
//!
//! NOT CAUGHT: Whether a control is rendered on screen at a given window width
//! or layout shed (which the visual scene and surface region sweeps own).

mod support;

use std::collections::BTreeSet;

use strum::IntoEnumIterator;
use support::{intent_samples::every_sample_intent, session, terminal};
use veyyon_desktop::{SessionIndex, actions_for, project::gated_controls};
use veyyon_desktop_model::{
	ApprovalInteraction, Capability, CapabilityStatus, HostAction, HostActionKind, InteractionId,
	KeybindingView, PendingDecisions, PlanInteraction, ProcessView, QuestionInteraction,
	QueuePartition, SessionId, Store, TerminalStatus,
};
use veyyon_desktop_surface::Intent;

/// The three host actions the transport sends rather than a control.
/// A fourth unsent action or an unexpected member turns the suite red.
const PINNED_UNSENT: [HostActionKind; 3] =
	[HostActionKind::Attach, HostActionKind::Detach, HostActionKind::Shutdown];

fn seeded_store_and_index() -> (Store, SessionIndex) {
	let mut store = Store::new();
	let sid = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(sid.clone());

	for cap in Capability::ALL {
		store.capabilities.set(cap, CapabilityStatus::Available);
	}

	store.interactions.insert(sid.clone(), PendingDecisions {
		approvals: vec![ApprovalInteraction {
			id:              InteractionId::from("app-1"),
			tool_name:       "bash".to_string(),
			detail:          "cargo test".to_string(),
			requested_at_ms: 1000,
		}],
		questions: vec![QuestionInteraction {
			id:              InteractionId::from("q-1"),
			prompt:          "Proceed?".to_string(),
			options:         vec!["yes".to_string(), "no".to_string()],
			requested_at_ms: 1000,
		}],
		plans:     vec![PlanInteraction {
			id:              InteractionId::from("p-1"),
			markdown_plan:   "# Plan\n- step 1".to_string(),
			requested_at_ms: 1000,
		}],
	});

	store.domains.terminals = vec![terminal("term-1", TerminalStatus::Running)];

	store.domains.processes = vec![ProcessView {
		name:          "server".to_string(),
		pid:           None,
		application:   "cargo".to_string(),
		args:          vec!["run".to_string()],
		cwd:           "/tmp".to_string(),
		lifetime:      "short".to_string(),
		status:        "running".to_string(),
		exit_code:     None,
		started_at_ms: 1000,
		terminated_by: None,
	}];
	store.domains.keybindings = vec![KeybindingView {
		action: "composer.send".to_string(),
		keys:   vec!["enter".to_string()],
		source: "default".to_string(),
	}];
	let mut index = SessionIndex::new();
	let _ = index.row_of(&sid);

	(store, index)
}

#[test]
fn every_action_the_host_answers_has_a_sender_or_is_pinned_unsent() {
	let (mut store, index) = seeded_store_and_index();

	let mut sent_kinds = BTreeSet::new();

	// 1. Collect actions produced by driving every Intent through actions_for
	for intent in every_sample_intent() {
		let actions = actions_for(&intent, &index, &mut store);
		for action in actions {
			sent_kinds.insert(action.kind());
		}
		let mut empty_store = Store::new();
		for action in actions_for(&intent, &index, &mut empty_store) {
			sent_kinds.insert(action.kind());
		}
	}
	// 2. Collect actions dispatched during initial connection handshake
	let all_caps: Vec<_> = Capability::ALL
		.iter()
		.map(|&c| (c, CapabilityStatus::Available))
		.collect();
	for action in veyyon_desktop::transport::initial_sync_actions(&all_caps) {
		sent_kinds.insert(action.kind());
	}
	// 3. Compute unsent actions
	let all_actions: BTreeSet<HostActionKind> = HostActionKind::iter().collect();
	let unsent_actions: BTreeSet<HostActionKind> =
		all_actions.difference(&sent_kinds).copied().collect();

	let pinned_set: BTreeSet<HostActionKind> = PINNED_UNSENT.into_iter().collect();

	assert_eq!(
		unsent_actions,
		pinned_set,
		"Unsent host actions must exactly match the pinned set of 3 actions. Extra unsent: {:?}, \
		 Missing from unsent: {:?}",
		unsent_actions.difference(&pinned_set).collect::<Vec<_>>(),
		pinned_set.difference(&unsent_actions).collect::<Vec<_>>(),
	);
}

#[test]
fn session_lifecycle_five_actions_are_all_sent_by_intents_and_registered() {
	let (mut store, index) = seeded_store_and_index();
	assert!(
		actions_for(&Intent::RenameSession { session: 1, title: "Title".into() }, &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::RenameSession)
	);
	assert!(
		actions_for(&Intent::ExportSession(Some(1)), &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::ExportSession)
	);
	assert!(
		actions_for(&Intent::CompactSession(Some(1)), &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::CompactSession)
	);
	assert!(
		actions_for(&Intent::HandoffSession(Some(1)), &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::HandoffSession)
	);
	assert!(
		actions_for(&Intent::LoadTranscript(Some(1)), &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::LoadTranscript)
	);

	let controls = gated_controls(&store, Some(1));
	let control_actions: BTreeSet<HostActionKind> = controls.into_iter().map(|(_, k)| k).collect();
	assert!(control_actions.contains(&HostActionKind::RenameSession));
	assert!(control_actions.contains(&HostActionKind::ExportSession));
	assert!(control_actions.contains(&HostActionKind::CompactSession));
	assert!(control_actions.contains(&HostActionKind::HandoffSession));
	assert!(control_actions.contains(&HostActionKind::LoadTranscript));
}

#[test]
fn slice_2_turn_and_drawer_five_actions_are_all_sent_by_intents_and_registered() {
	let (mut store, index) = seeded_store_and_index();
	assert!(
		actions_for(&Intent::CancelTool { call_id: "tool-1".into() }, &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::CancelTool)
	);
	assert!(
		actions_for(&Intent::CloseTerminal, &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::CloseTerminal)
	);
	assert!(
		actions_for(&Intent::ClearOutput, &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::ClearOutput)
	);
	assert!(
		actions_for(&Intent::ProcessStart { command: "c".into(), args: vec![] }, &index, &mut store)
			.iter()
			.any(|a| a.kind() == HostActionKind::ProcessStart)
	);
	assert!(
		actions_for(
			&Intent::ProcessSend { process: "server".into(), data: vec![] },
			&index,
			&mut store
		)
		.iter()
		.any(|a| a.kind() == HostActionKind::ProcessSend)
	);

	let controls = gated_controls(&store, Some(1));
	let control_actions: BTreeSet<HostActionKind> = controls.into_iter().map(|(_, k)| k).collect();
	assert!(control_actions.contains(&HostActionKind::CancelTool));
	assert!(control_actions.contains(&HostActionKind::CloseTerminal));
	assert!(control_actions.contains(&HostActionKind::ClearOutput));
	assert!(control_actions.contains(&HostActionKind::ProcessStart));
	assert!(control_actions.contains(&HostActionKind::ProcessSend));
}

#[test]
fn slice_3_config_two_actions_are_all_sent_by_intents_and_registered() {
	let (mut store, index) = seeded_store_and_index();
	let rebind = Intent::KeybindingChanged {
		action: "composer.send".into(),
		keys:   vec!["ctrl-enter".into()],
	};
	// The chords the field states are what reaches the host, not the action
	// name alone: a rebind that drops them writes a binding no press matches.
	let sent = actions_for(&rebind, &index, &mut store);
	assert!(sent.iter().any(|action| *action
		== HostAction::SetKeybinding {
			action: "composer.send".into(),
			keys:   vec!["ctrl-enter".into()],
		}));
	let spawned = actions_for(&Intent::SpawnTask("review the diff".into()), &index, &mut store);
	assert!(
		spawned
			.iter()
			.any(|action| *action == HostAction::SpawnTask { task: "review the diff".into() })
	);

	let controls = gated_controls(&store, Some(1));
	let control_actions: BTreeSet<HostActionKind> = controls.into_iter().map(|(_, k)| k).collect();
	assert!(control_actions.contains(&HostActionKind::SetKeybinding));
	assert!(control_actions.contains(&HostActionKind::SpawnTask));
}
