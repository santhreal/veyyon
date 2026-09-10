//! WHY: a click on a card or the composer reached no host until `actions_for`
//! turned a shell `Intent` into the `HostAction`s the host answers. This
//! suite is that direction of the projection.
//!
//! CLASS CLOSED: an `Intent` variant that reaches no action by accident. Every
//! variant is exercised, so an intent that maps to nothing is a decision made
//! here rather than a silence. Also a decision delivered to the wrong
//! interaction: a card position of one kind answered with another kind's
//! payload, an option that does not exist, and a card answered twice.
//!
//! NOT CAUGHT: whether the host honours the action; that is the live handshake
//! suite. Control projection and capability gating are in
//! `control-availability-and-contextual-statuses-project-from-capabilities.rs`;
//! session metadata projection is in
//! `session-titles-and-clock-metadata-project-verbatim.rs`.

mod support;

use std::{collections::HashMap, path::PathBuf};

use support::{NOW_MS, session, terminal};
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{
	ApprovalInteraction, AttachmentSubmission, HostAction, HostEvent, InteractionId,
	PendingDecisions, PlanInteraction, QuestionInteraction, QueuePartition, SessionId,
	SnapshotSection, Store, SurfaceId, TerminalStatus, reduce,
};
use veyyon_desktop_surface::{
	Attachment, Card, Intent, MediaType, PanelTab, ShellState, composer::payload_for,
};

fn store_with_decisions() -> (Store, SessionIndex) {
	let mut store = Store::new();
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	store
		.interactions
		.insert(SessionId::from("s"), PendingDecisions {
			approvals: vec![ApprovalInteraction {
				id:              InteractionId::from("i-approve"),
				tool_name:       "bash".to_string(),
				detail:          "rm -rf build\nthen rebuild".to_string(),
				requested_at_ms: NOW_MS,
			}],
			questions: vec![
				QuestionInteraction {
					id:              InteractionId::from("i-ask"),
					prompt:          "Which?".to_string(),
					options:         vec!["left".to_string(), "right".to_string()],
					requested_at_ms: NOW_MS,
				},
				QuestionInteraction {
					id:              InteractionId::from("i-free"),
					prompt:          "Name it".to_string(),
					options:         Vec::new(),
					requested_at_ms: NOW_MS,
				},
			],
			plans:     vec![PlanInteraction {
				id:              InteractionId::from("i-plan"),
				markdown_plan:   "# Ship it\n- step".to_string(),
				requested_at_ms: NOW_MS,
			}],
		});
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert!(
		matches!(&state.cards[..], [
			Card::Approval { .. },
			Card::Question { .. },
			Card::Question { .. },
			Card::Plan { .. }
		]),
		"approvals, then questions, then plans: {:?}",
		state.cards
	);
	assert!(
		matches!(&state.cards[3], Card::Plan { title, body } if title == "Ship it" && body == &["- step"])
	);
	(store, index)
}

#[test]
fn every_intent_maps_to_the_actions_the_host_answers_or_to_none_on_purpose() {
	let (mut store, mut index) = store_with_decisions();
	let row = index.row_of(&SessionId::from("s"));
	let session = SessionId::from("s");

	assert_eq!(
		actions_for(&Intent::SelectSession(row), &index, &mut store),
		[HostAction::OpenSession { session: session.clone() }, HostAction::RefreshChanges],
		"opening a session also asks for the changes the panel shows"
	);
	assert!(actions_for(&Intent::SelectSession(999), &index, &mut store).is_empty());
	assert_eq!(
		actions_for(
			&Intent::Send { text: "hello".into(), attachments: Vec::new() },
			&index,
			&mut store
		),
		[HostAction::SubmitPrompt {
			session:     session.clone(),
			text:        "hello".into(),
			attachments: Vec::new(),
		}]
	);
	// An attachment reaches the host with its bytes, its sniffed media type
	// and an id that distinguishes two chips carrying the same file.
	let png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
	let picked = Attachment::from_path(
		PathBuf::from("/repo/shot.png"),
		MediaType::Png,
		payload_for(MediaType::Png, png.clone()),
	);
	let pasted =
		Attachment::from_clipboard(2, MediaType::Png, payload_for(MediaType::Png, png.clone()));
	assert_eq!(
		actions_for(
			&Intent::Send { text: "look".into(), attachments: vec![picked, pasted] },
			&index,
			&mut store
		),
		[HostAction::SubmitPrompt {
			session:     session.clone(),
			text:        "look".into(),
			attachments: vec![
				AttachmentSubmission {
					id:         "0:/repo/shot.png".into(),
					name:       "shot.png".into(),
					media_type: "image/png".into(),
					data:       png.clone(),
				},
				AttachmentSubmission {
					id:         "1:clipboard:2".into(),
					name:       "Pasted image 2.png".into(),
					media_type: "image/png".into(),
					data:       png,
				},
			],
		}]
	);
	// This store's host has stated no capability, so the tab it draws is asked
	// for nothing. What each tab asks for once a capability is available is
	// `a-workspace-tab-restates-the-domain-it-draws.rs`.
	assert!(actions_for(&Intent::SelectTab(PanelTab::Diff), &index, &mut store).is_empty());
	assert!(actions_for(&Intent::SetDrawer { open: false }, &index, &mut store).is_empty());

	// Answer the plan (position 3) first: its id is the plan's, and the
	// cards before it keep their positions.
	let plan = actions_for(&Intent::Plan { card: 3, accepted: true }, &index, &mut store);
	assert_eq!(plan, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-plan".into(),
		response:       serde_json::json!({ "accepted": true }),
	}]);
	let answer = actions_for(&Intent::Answer { card: 1, option: 1 }, &index, &mut store);
	assert_eq!(answer, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-ask".into(),
		response:       serde_json::json!({ "option": 1, "text": "right" }),
	}]);
	// The free-text question moved up to position 1 and takes the composer's
	// text as its answer.
	let reply = actions_for(&Intent::Reply { card: 1, text: "widget".into() }, &index, &mut store);
	assert_eq!(reply, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-free".into(),
		response:       serde_json::json!({ "text": "widget" }),
	}]);
	// The approval is now the only card, at position 0, in both stacks.
	let approval = actions_for(
		&Intent::Approval { card: 0, approved: false, standing: false },
		&index,
		&mut store,
	);
	assert_eq!(approval, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-approve".into(),
		response:       serde_json::json!({ "approved": false, "scope": "once" }),
	}]);
	assert!(
		actions_for(
			&Intent::Approval { card: 0, approved: true, standing: true },
			&index,
			&mut store
		)
		.is_empty(),
		"an answered card is not answered twice"
	);
	assert!(store.interactions[&session].is_empty());
}

#[test]
fn opening_the_drawer_attaches_to_the_running_terminal_or_creates_one() {
	let (mut store, index) = store_with_decisions();
	assert_eq!(
		actions_for(&Intent::SetDrawer { open: true }, &index, &mut store),
		[HostAction::CreateTerminal { cwd: None, shell: None }],
		"with no terminal, the drawer asks for one"
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![
			terminal("t1", TerminalStatus::Running),
			terminal("t2", TerminalStatus::Exited { code: 1 }),
		])),
	);
	assert_eq!(
		actions_for(&Intent::SetDrawer { open: true }, &index, &mut store),
		[HostAction::AttachTerminal { terminal_id: "t1".into() }],
		"with one running, the drawer attaches to it and replays its scrollback"
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![terminal(
			"t1",
			TerminalStatus::Failed { message: "no shell".into() },
		)])),
	);
	assert_eq!(
		actions_for(&Intent::SetDrawer { open: true }, &index, &mut store),
		[HostAction::CreateTerminal { cwd: None, shell: None }],
		"a terminal that failed is not one to attach to"
	);
}

#[test]
fn a_decision_at_a_position_of_the_wrong_kind_is_dropped_not_misdelivered() {
	let (mut store, index) = store_with_decisions();
	// Position 0 is the approval; asking to answer it as a question must not
	// resolve the approval with a question's payload.
	assert!(actions_for(&Intent::Answer { card: 0, option: 0 }, &index, &mut store).is_empty());
	assert!(actions_for(&Intent::Plan { card: 1, accepted: true }, &index, &mut store).is_empty());
	assert!(
		actions_for(&Intent::Reply { card: 0, text: "no".into() }, &index, &mut store).is_empty(),
		"a reply is a question's answer, never an approval's"
	);
	assert!(
		actions_for(&Intent::Answer { card: 1, option: 5 }, &index, &mut store).is_empty(),
		"an option that does not exist is not sent"
	);
	let pending = &store.interactions[&SessionId::from("s")];
	assert_eq!(
		(pending.approvals.len(), pending.questions.len(), pending.plans.len()),
		(1, 1, 1),
		"the mis-kinded answers took nothing; the bad option took its question"
	);
}

#[test]
fn settings_diagnostics_usage_and_mcp_intents_map_to_host_actions() {
	let (mut store, index) = store_with_decisions();

	assert_eq!(actions_for(&Intent::ResetSetting("editor.tabSize".into()), &index, &mut store), [
		HostAction::ResetSetting { key: "editor.tabSize".into() }
	]);
	assert_eq!(
		actions_for(
			&Intent::SetMcpEnabled { server: "fetch".into(), enabled: true },
			&index,
			&mut store
		),
		[HostAction::SetMcpEnabled { server: "fetch".into(), enabled: true }]
	);
	assert_eq!(actions_for(&Intent::RefreshDiagnostics, &index, &mut store), [
		HostAction::RefreshDiagnostics
	]);
	assert_eq!(actions_for(&Intent::RetryDiagnosticSource("eslint".into()), &index, &mut store), [
		HostAction::RetryDiagnosticSource { source: "eslint".into() }
	]);
	assert_eq!(actions_for(&Intent::RefreshUsage, &index, &mut store), [
		HostAction::GetUsage { session: Some(SessionId::from("s")) },
		HostAction::GetContextBreakdown { session: SessionId::from("s") }
	]);
	// The turn footer opens the accounting, so it fetches the same figures the
	// refresh control does rather than showing whatever the panel last held.
	assert_eq!(actions_for(&Intent::OpenUsage, &index, &mut store), [
		HostAction::GetUsage { session: Some(SessionId::from("s")) },
		HostAction::GetContextBreakdown { session: SessionId::from("s") }
	]);
}

#[test]
fn retry_control_dispatches_correct_action_for_each_surface() {
	let (mut store, index) = store_with_decisions();

	assert_eq!(
		actions_for(&Intent::RetryControl(SurfaceId::DiagnosticRefreshButton), &index, &mut store),
		[HostAction::RefreshDiagnostics]
	);
	assert_eq!(
		actions_for(&Intent::RetryControl(SurfaceId::UsageRefreshButton), &index, &mut store),
		[HostAction::GetUsage { session: Some(SessionId::from("s")) }]
	);
	assert_eq!(
		actions_for(
			&Intent::RetryControl(SurfaceId::ContextBreakdownRefreshButton),
			&index,
			&mut store
		),
		[HostAction::GetContextBreakdown { session: SessionId::from("s") }]
	);
	assert_eq!(
		actions_for(
			&Intent::RetryControl(SurfaceId::DiagnosticRetrySourceButton("cargo".into())),
			&index,
			&mut store
		),
		[HostAction::RetryDiagnosticSource { source: "cargo".into() }]
	);
	assert_eq!(
		actions_for(
			&Intent::RetryControl(SurfaceId::ProviderAuthStartButton("anthropic".into())),
			&index,
			&mut store
		),
		[HostAction::StartProviderAuth { provider: "anthropic".into() }]
	);
}

#[test]
fn session_pin_defer_and_park_mutate_store_partitions() {
	let (mut store, index) = store_with_decisions();
	let row = index.row_id(&SessionId::from("s")).unwrap();

	assert!(actions_for(&Intent::PinSession(row), &index, &mut store).is_empty());
	assert!(store.sessions.pinned.contains(&SessionId::from("s")));

	assert!(actions_for(&Intent::DeferSession(row), &index, &mut store).is_empty());
	assert!(store.sessions.deferred.contains(&SessionId::from("s")));

	assert!(actions_for(&Intent::ParkSession(row), &index, &mut store).is_empty());
	assert!(store.sessions.parked.contains(&SessionId::from("s")));
}

#[test]
fn session_lifecycle_intents_map_to_host_actions() {
	let (mut store, index) = store_with_decisions();
	let row = index.row_id(&SessionId::from("s")).unwrap();

	assert_eq!(
		actions_for(
			&Intent::RenameSession { session: row, title: "Renamed".into() },
			&index,
			&mut store,
		),
		[HostAction::RenameSession { session: SessionId::from("s"), title: "Renamed".into() }]
	);
	assert_eq!(actions_for(&Intent::ExportSession(Some(row)), &index, &mut store), [
		HostAction::ExportSession { session: SessionId::from("s"), format: "html".into() }
	]);
	assert_eq!(actions_for(&Intent::CompactSession(Some(row)), &index, &mut store), [
		HostAction::CompactSession { session: SessionId::from("s") }
	]);
	assert_eq!(actions_for(&Intent::HandoffSession(Some(row)), &index, &mut store), [
		HostAction::HandoffSession { session: SessionId::from("s"), target: String::new() }
	]);
	assert_eq!(actions_for(&Intent::LoadTranscript(Some(row)), &index, &mut store), [
		HostAction::LoadTranscript { session: SessionId::from("s"), before: None }
	]);
}
#[test]
fn turn_and_drawer_intents_map_to_host_actions() {
	let (mut store, index) = store_with_decisions();
	store.domains.terminals =
		vec![support::terminal("t", veyyon_desktop_model::TerminalStatus::Running)];
	let s = SessionId::from("s");
	assert_eq!(actions_for(&Intent::CancelTool { call_id: "t1".into() }, &index, &mut store), [
		HostAction::CancelTool { session: s.clone(), tool_call_id: "t1".into() }
	]);
	assert_eq!(actions_for(&Intent::CloseTerminal, &index, &mut store), [
		HostAction::CloseTerminal { terminal_id: "t".into() }
	]);
	// A create, not an attach: the drawer already shows a terminal here, and
	// `New` is what asks for one more.
	assert_eq!(actions_for(&Intent::NewTerminal, &index, &mut store), [
		HostAction::CreateTerminal { cwd: None, shell: None }
	]);
	assert_eq!(actions_for(&Intent::ClearOutput, &index, &mut store), [HostAction::ClearOutput {
		session: s,
	}]);
	assert_eq!(
		actions_for(
			&Intent::ProcessStart { command: "cmd".into(), args: vec!["arg".into()] },
			&index,
			&mut store
		),
		[HostAction::ProcessStart { command: "cmd".into(), args: vec!["arg".into()] }]
	);
	assert_eq!(
		actions_for(
			&Intent::ProcessSend { process: "p".into(), data: vec![1, 2] },
			&index,
			&mut store
		),
		[HostAction::ProcessSend { process_id: "p".into(), data: vec![1, 2] }]
	);
}
