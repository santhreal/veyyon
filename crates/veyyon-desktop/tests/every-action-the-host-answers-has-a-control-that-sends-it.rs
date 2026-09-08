//! WHY: Twenty-one of seventy-five host actions had no sender outside test
//! suites, leaving a quarter of the protocol unreachable from the native
//! desktop front end.
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
use support::{session, terminal};
use veyyon_desktop::{SessionIndex, actions_for, project::gated_controls};
use veyyon_desktop_model::{
	ApprovalInteraction, Capability, CapabilityStatus, HostActionKind, InteractionId,
	PendingDecisions, PlanInteraction, ProcessView, QuestionInteraction, QueuePartition, SessionId,
	Store, SurfaceId, TerminalStatus,
};
use veyyon_desktop_surface::{
	Attachment, Intent, IntentDiscriminants, MediaType, ModelChoice, Overlay, PaletteState, Payload,
	QueueMode, ScrollBy, SettingsPage, ThinkingLevel, ToolViewTarget, navigation::SurfaceRoute,
};

/// The fourteen host actions intentionally left unsent for later slices.
/// A fifteenth unsent action or an unexpected member turns the suite red.
const PINNED_UNSENT: [HostActionKind; 14] = [
	HostActionKind::Attach,
	HostActionKind::Detach,
	HostActionKind::Shutdown,
	HostActionKind::CancelTool,
	HostActionKind::CloseTerminal,
	HostActionKind::ProcessStart,
	HostActionKind::ProcessSend,
	HostActionKind::RefreshAuth,
	HostActionKind::ConnectMcp,
	HostActionKind::DisconnectMcp,
	HostActionKind::CallMcpTool,
	HostActionKind::SpawnTask,
	HostActionKind::SetKeybinding,
	HostActionKind::ClearOutput,
];

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
	let mut index = SessionIndex::new();
	let _ = index.row_of(&sid);

	(store, index)
}

/// Exhaustive match on `IntentDiscriminants` ensuring any new Intent variant
/// must be handled here to compile.
fn sample_intents_for_discriminant(disc: IntentDiscriminants) -> Vec<Intent> {
	match disc {
		IntentDiscriminants::SelectSession => vec![Intent::SelectSession(1)],
		IntentDiscriminants::SelectTab => vec![Intent::SelectTab(0)],
		IntentDiscriminants::SetDrawer => vec![Intent::SetDrawer { open: true }],
		IntentDiscriminants::Approval => {
			vec![Intent::Approval { card: 0, approved: true, standing: false }]
		},
		IntentDiscriminants::Answer => vec![Intent::Answer { card: 0, option: 0 }],
		IntentDiscriminants::Reply => {
			vec![Intent::Reply { card: 0, text: "sample reply".to_string() }]
		},
		IntentDiscriminants::Plan => vec![Intent::Plan { card: 0, accepted: true }],
		IntentDiscriminants::Send => {
			vec![Intent::Send { text: "hello".to_string(), attachments: vec![] }]
		},
		IntentDiscriminants::Steer => vec![Intent::Steer("steer text".to_string())],
		IntentDiscriminants::Queue => vec![Intent::Queue("queue text".to_string())],
		IntentDiscriminants::AbortTurn => vec![Intent::AbortTurn],
		IntentDiscriminants::SetQueueMode => vec![Intent::SetQueueMode(QueueMode::Steer)],
		IntentDiscriminants::SelectModel => vec![Intent::SelectModel(ModelChoice {
			provider: "anthropic".to_string(),
			model:    "claude-3-5-sonnet".to_string(),
		})],
		IntentDiscriminants::SetThinking => {
			vec![Intent::SetThinking(ThinkingLevel { level: "high".to_string() })]
		},
		IntentDiscriminants::DequeueQueuedPrompt => vec![Intent::DequeueQueuedPrompt],
		IntentDiscriminants::Attach => vec![Intent::Attach(Attachment::from_path(
			"test.png".into(),
			MediaType::Png,
			Payload::Video(vec![].into()),
		))],
		IntentDiscriminants::RemoveAttachment => vec![Intent::RemoveAttachment(0)],
		IntentDiscriminants::RetryConnection => vec![Intent::RetryConnection],
		IntentDiscriminants::StartProviderAuth => {
			vec![Intent::StartProviderAuth("anthropic".to_string())]
		},
		IntentDiscriminants::SubmitAuthSecret => vec![Intent::SubmitAuthSecret {
			provider: "anthropic".to_string(),
			secret:   "sk-test".to_string(),
		}],
		IntentDiscriminants::OpenAuthUrl => {
			vec![Intent::OpenAuthUrl("https://auth.example.com".to_string())]
		},
		IntentDiscriminants::CancelAuthFlow => vec![Intent::CancelAuthFlow],
		IntentDiscriminants::RetryAuthFlow => vec![Intent::RetryAuthFlow],
		IntentDiscriminants::RetryControl => vec![
			Intent::RetryControl(SurfaceId::DiagnosticRefreshButton),
			Intent::RetryControl(SurfaceId::UsageRefreshButton),
			Intent::RetryControl(SurfaceId::ContextBreakdownRefreshButton),
			Intent::RetryControl(SurfaceId::DiagnosticRetrySourceButton("cargo".to_string())),
			Intent::RetryControl(SurfaceId::AgentReviveButton("agent-1".to_string())),
			Intent::RetryControl(SurfaceId::TaskCancelButton("task-1".to_string())),
			Intent::RetryControl(SurfaceId::ConnectionRetryButton),
			Intent::RetryControl(SurfaceId::ProviderAuthRetryButton("anthropic".to_string())),
			Intent::RetryControl(SurfaceId::ProviderAuthStartButton("anthropic".to_string())),
			Intent::RetryControl(SurfaceId::ProviderAuthCancelButton("anthropic".to_string())),
		],
		IntentDiscriminants::DismissError => {
			vec![Intent::DismissError(SurfaceId::DiagnosticRefreshButton)]
		},
		IntentDiscriminants::OpenOverlay => {
			vec![Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::default())))]
		},
		IntentDiscriminants::Navigate => SettingsPage::iter()
			.map(|page| Intent::Navigate(SurfaceRoute::Page(page)))
			.collect(),
		IntentDiscriminants::CloseOverlay => vec![Intent::CloseOverlay],
		IntentDiscriminants::PaletteQuery => vec![Intent::PaletteQuery("query".to_string())],
		IntentDiscriminants::PaletteMove => vec![Intent::PaletteMove(1)],
		IntentDiscriminants::PaletteRun => vec![Intent::PaletteRun],
		IntentDiscriminants::BrowseTo => vec![Intent::BrowseTo { path: None }],
		IntentDiscriminants::FindFile => vec![Intent::FindFile("main.rs".to_string())],
		IntentDiscriminants::FindText => vec![Intent::FindText("pattern".to_string())],
		IntentDiscriminants::SettingChanged => vec![Intent::SettingChanged {
			key:   "theme".to_string(),
			value: serde_json::json!("dark"),
		}],
		IntentDiscriminants::ResetSetting => vec![Intent::ResetSetting("theme".to_string())],
		IntentDiscriminants::SelectTheme => vec![Intent::SelectTheme("dark".to_string())],
		IntentDiscriminants::ReloadSettings => vec![Intent::ReloadSettings],
		IntentDiscriminants::SetMcpEnabled => {
			vec![Intent::SetMcpEnabled { server: "mcp-server".to_string(), enabled: true }]
		},
		IntentDiscriminants::RefreshDiagnostics => vec![Intent::RefreshDiagnostics],
		IntentDiscriminants::RetryDiagnosticSource => {
			vec![Intent::RetryDiagnosticSource("cargo".to_string())]
		},
		IntentDiscriminants::RefreshUsage => vec![Intent::RefreshUsage],
		IntentDiscriminants::TerminalInput => vec![Intent::TerminalInput(vec![b'l', b's', b'\n'])],
		IntentDiscriminants::ResizeTerminal => {
			vec![Intent::ResizeTerminal { cols: 120, rows: 40 }]
		},
		IntentDiscriminants::SelectDrawerTab => vec![Intent::SelectDrawerTab(0)],
		IntentDiscriminants::OpenProcessLogs => {
			vec![Intent::OpenProcessLogs("server".to_string())]
		},
		IntentDiscriminants::ClearTerminal => vec![Intent::ClearTerminal],
		IntentDiscriminants::RestartTerminal => vec![Intent::RestartTerminal],
		IntentDiscriminants::ProcessStop => vec![Intent::ProcessStop("server".to_string())],
		IntentDiscriminants::ProcessRestart => vec![Intent::ProcessRestart("server".to_string())],
		IntentDiscriminants::ProcessSignal => vec![Intent::ProcessSignal("server".to_string())],
		IntentDiscriminants::PinSession => vec![Intent::PinSession(1)],
		IntentDiscriminants::UnpinSession => vec![Intent::UnpinSession(1)],
		IntentDiscriminants::DeferSession => vec![Intent::DeferSession(1)],
		IntentDiscriminants::ParkSession => vec![Intent::ParkSession(1)],
		IntentDiscriminants::UnparkSession => vec![Intent::UnparkSession(1)],
		IntentDiscriminants::RecallSession => vec![Intent::RecallSession(1)],
		IntentDiscriminants::DeleteSession => vec![Intent::DeleteSession(1)],
		IntentDiscriminants::BranchSession => vec![Intent::BranchSession(1)],
		IntentDiscriminants::RenameSession => {
			vec![Intent::RenameSession { session: 1, title: "Renamed Session".to_string() }]
		},
		IntentDiscriminants::ExportSession => vec![Intent::ExportSession(Some(1))],
		IntentDiscriminants::CompactSession => vec![Intent::CompactSession(Some(1))],
		IntentDiscriminants::HandoffSession => vec![Intent::HandoffSession(Some(1))],
		IntentDiscriminants::LoadTranscript => vec![Intent::LoadTranscript(Some(1))],
		IntentDiscriminants::FilterQueue => vec![Intent::FilterQueue("filter".to_string())],
		IntentDiscriminants::NewSession => vec![Intent::NewSession],
		IntentDiscriminants::CloseTabOrPark => vec![Intent::CloseTabOrPark],
		IntentDiscriminants::MoveQueueSelection => vec![Intent::MoveQueueSelection(1)],
		IntentDiscriminants::ScrollTranscript => vec![Intent::ScrollTranscript(ScrollBy::PageDown)],
		IntentDiscriminants::FindInTranscript => vec![Intent::FindInTranscript],
		IntentDiscriminants::StepTurn => vec![Intent::StepTurn(1)],
		IntentDiscriminants::ToggleBlock => vec![Intent::ToggleBlock],
		IntentDiscriminants::SetToolViewExpanded => {
			vec![Intent::SetToolViewExpanded { call_id: "call-1".to_string(), expanded: true }]
		},
		IntentDiscriminants::OpenToolTarget => {
			vec![Intent::OpenToolTarget(ToolViewTarget::Url("https://example.com".to_string()))]
		},
		IntentDiscriminants::ToggleQueue => vec![Intent::ToggleQueue],
		IntentDiscriminants::SetPanel => vec![Intent::SetPanel { open: true }],
		IntentDiscriminants::SetDiffMode => {
			vec![Intent::SetDiffMode(veyyon_desktop_model::DiffMode::Unified)]
		},
		IntentDiscriminants::OpenFile => vec![Intent::OpenFile("src/lib.rs".to_string())],
		IntentDiscriminants::OpenUsage => vec![Intent::OpenUsage],
		IntentDiscriminants::ToggleTreeNode => {
			vec![Intent::ToggleTreeNode("src/lib.rs".to_string())]
		},
		IntentDiscriminants::ExpandContext => vec![Intent::ExpandContext { file: 0, row: 0 }],
		IntentDiscriminants::SelectChangeScope => {
			vec![Intent::SelectChangeScope(veyyon_desktop_model::ChangeScope::WorkingTree)]
		},
	}
}

#[test]
fn every_action_the_host_answers_has_a_sender_or_is_pinned_unsent() {
	let (mut store, index) = seeded_store_and_index();

	let mut sent_kinds = BTreeSet::new();

	// 1. Collect actions produced by driving every Intent through actions_for
	for disc in IntentDiscriminants::iter() {
		for intent in sample_intents_for_discriminant(disc) {
			let actions = actions_for(&intent, &index, &mut store);
			for action in actions {
				sent_kinds.insert(action.kind());
			}
			let mut empty_store = Store::new();
			for action in actions_for(&intent, &index, &mut empty_store) {
				sent_kinds.insert(action.kind());
			}
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
		"Unsent host actions must exactly match the pinned set of 16 actions. Extra unsent: {:?}, \
		 Missing from unsent: {:?}",
		unsent_actions.difference(&pinned_set).collect::<Vec<_>>(),
		pinned_set.difference(&unsent_actions).collect::<Vec<_>>(),
	);
}

#[test]
fn session_lifecycle_five_actions_are_all_sent_by_intents_and_registered() {
	let (mut store, index) = seeded_store_and_index();

	// Verify RenameSession
	let rename_actions = actions_for(
		&Intent::RenameSession { session: 1, title: "New Title".to_string() },
		&index,
		&mut store,
	);
	assert!(
		rename_actions
			.iter()
			.any(|a| a.kind() == HostActionKind::RenameSession),
		"RenameSession must be produced by actions_for"
	);

	// Verify ExportSession
	let export_actions = actions_for(&Intent::ExportSession(Some(1)), &index, &mut store);
	assert!(
		export_actions
			.iter()
			.any(|a| a.kind() == HostActionKind::ExportSession),
		"ExportSession must be produced by actions_for"
	);

	// Verify CompactSession
	let compact_actions = actions_for(&Intent::CompactSession(Some(1)), &index, &mut store);
	assert!(
		compact_actions
			.iter()
			.any(|a| a.kind() == HostActionKind::CompactSession),
		"CompactSession must be produced by actions_for"
	);

	// Verify HandoffSession
	let handoff_actions = actions_for(&Intent::HandoffSession(Some(1)), &index, &mut store);
	assert!(
		handoff_actions
			.iter()
			.any(|a| a.kind() == HostActionKind::HandoffSession),
		"HandoffSession must be produced by actions_for"
	);

	// Verify LoadTranscript
	let load_actions = actions_for(&Intent::LoadTranscript(Some(1)), &index, &mut store);
	assert!(
		load_actions
			.iter()
			.any(|a| a.kind() == HostActionKind::LoadTranscript),
		"LoadTranscript must be produced by actions_for"
	);

	// Verify controls.rs registrations
	let controls = gated_controls(&store, Some(1));
	let control_actions: BTreeSet<HostActionKind> = controls.into_iter().map(|(_, k)| k).collect();
	assert!(control_actions.contains(&HostActionKind::RenameSession));
	assert!(control_actions.contains(&HostActionKind::ExportSession));
	assert!(control_actions.contains(&HostActionKind::CompactSession));
	assert!(control_actions.contains(&HostActionKind::HandoffSession));
	assert!(control_actions.contains(&HostActionKind::LoadTranscript));
}
