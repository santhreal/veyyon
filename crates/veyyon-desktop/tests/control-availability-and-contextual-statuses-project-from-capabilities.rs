//! WHY: interactive controls and contextual surfaces (diff, file tree) must
//! reflect host capabilities and in-flight request states rather than assuming
//! permanent availability or hanging in infinite loading on failure.
//!
//! CLASS CLOSED: controls enabled when their specific capability is disabled or
//! unknown; contextual panel tabs failing to transition through loading,
//! loaded, unloaded, and failed states; composer overriding host-unspecified
//! models or thinking levels with synthetic defaults.
//!
//! NOT CAUGHT: pixel-level button rendering or theme styling; live socket
//! request execution. Intent action mapping is in
//! `an-intent-maps-to-the-actions-the-host-answers.rs`.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{
	SessionIndex, actions_for, contextual_surface_for_action, project,
	project::{project_composer, project_panel},
	project_controls,
};
use veyyon_desktop_model::{
	ApprovalInteraction, Capability, CapabilityStatus, ChangesView, ConnectionState, Domains,
	FileTreeView, HostAction, HostActionKind, InteractionId, ModelView, ModelsView,
	PROTOCOL_VERSION, PendingDecisions, PlanInteraction, QuestionInteraction, QueuePartition,
	RequestId, RequestRegistry, SessionId, Store, SurfaceId,
};
use veyyon_desktop_surface::{
	Card, ComposerState, ControlError, DiffStatus, Intent, PanelContent, ShellState, TreeStatus,
	controls::Availability,
};

fn store_with_decisions() -> (Store, SessionIndex) {
	let mut store = Store::new();
	// What this suite reads is the capability map. A store left detached is
	// narrowed by the transport instead (`transport_gate`, §8.12), which is
	// `a-control-is-offered-only-while-the-transport-can-carry-it.rs`.
	store.connection = ConnectionState::Connected {
		endpoint: "127.0.0.1:47000".to_string(),
		protocol: PROTOCOL_VERSION,
	};
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
fn composer_preserves_host_unspecified_model_and_thinking_level() {
	let mut store = Store::new();
	store
		.capabilities
		.set(Capability::Models, CapabilityStatus::Available);
	store.domains.models = Some(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".into(),
			id:             "claude-3-5-sonnet".into(),
			name:           "Claude 3.5 Sonnet".into(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     8192,
			input:          Vec::new(),
		}],
		current:         None,
		thinking_level:  None,
		thinking_levels: vec!["low".into(), "medium".into(), "high".into()],
	});

	let mut composer = ComposerState::default();
	project_composer(&store, None, &mut composer);

	let model = composer.model.expect("model control projected");
	assert_eq!(
		model.current, None,
		"unspecified current model from host remains None without fabrication"
	);
	assert_eq!(model.label(), None);
	assert_eq!(composer.thinking, None, "unspecified thinking level from host remains None");
}

#[test]
fn questions_and_plans_gate_by_their_own_capability_not_approvals() {
	let (mut store, index) = store_with_decisions();
	store
		.capabilities
		.set(Capability::Approvals, CapabilityStatus::Available);
	store
		.capabilities
		.set(Capability::Questions, CapabilityStatus::Unavailable {
			reason: "questions disabled".into(),
		});
	store
		.capabilities
		.set(Capability::Plans, CapabilityStatus::Unavailable { reason: "plans disabled".into() });

	let mut state = ShellState::default();
	let registry = RequestRegistry::new();
	let row = SessionId::from(index.row_id(&SessionId::from("s")).unwrap().to_string());

	project_controls(&store, &registry, &index, &mut state);

	let approval_surface =
		SurfaceId::ApprovalApproveButton(row.clone(), InteractionId::from("i-approve"));
	assert_eq!(
		state.controls.availability(&approval_surface),
		Availability::Enabled,
		"approvals are available"
	);

	let question_surface =
		SurfaceId::QuestionSubmitButton(row.clone(), InteractionId::from("i-ask"));
	assert_eq!(
		state.controls.availability(&question_surface),
		Availability::Unavailable { reason: "questions disabled".into() },
		"questions are gated on Capability::Questions"
	);

	let plan_accept = SurfaceId::PlanAcceptButton(row, InteractionId::from("i-plan"));
	assert_eq!(
		state.controls.availability(&plan_accept),
		Availability::Unavailable { reason: "plans disabled".into() },
		"plans are gated on Capability::Plans"
	);
}

#[test]
fn contextual_statuses_transition_through_loading_loaded_unloaded_and_failed() {
	let (mut store, index) = store_with_decisions();
	let mut registry = RequestRegistry::new();
	let mut state = ShellState::default();
	let session = SessionId::from("s");
	let row = SessionId::from(index.row_id(&session).unwrap().to_string());

	// 0. Test helper contextual_surface_for_action
	assert_eq!(
		contextual_surface_for_action(HostActionKind::RefreshChanges, &session),
		Some(SurfaceId::RightPanelDiffTab(session.clone()))
	);
	assert_eq!(
		contextual_surface_for_action(HostActionKind::LoadFileTree, &session),
		Some(SurfaceId::RightPanelFileTab(session.clone()))
	);
	assert_eq!(
		contextual_surface_for_action(HostActionKind::SelectChangeScope, &session),
		Some(SurfaceId::RightPanelChangeScopeSelector(session.clone()))
	);

	// 1. Initial / Unloaded state: no snapshot and no in-flight requests
	store
		.capabilities
		.set(Capability::Changes, CapabilityStatus::Available);
	store
		.capabilities
		.set(Capability::Files, CapabilityStatus::Available);
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(state.panel.diff_status, DiffStatus::Unloaded);
	assert_eq!(state.panel.tree.status, TreeStatus::Unloaded);

	// 2. Loading state: requests registered in-flight
	let req1 = RequestId(1001);
	let req2 = RequestId(1002);
	registry.register(
		req1,
		HostActionKind::RefreshChanges,
		SurfaceId::RightPanelDiffTab(row.clone()),
		NOW_MS,
		30_000,
	);
	registry.register(
		req2,
		HostActionKind::LoadFileTree,
		SurfaceId::RightPanelFileTab(row.clone()),
		NOW_MS,
		30_000,
	);
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(state.panel.diff_status, DiffStatus::Loading);
	assert_eq!(state.panel.tree.status, TreeStatus::Loading);

	// 3. Error / Failure: requests complete with error, landing ControlError on
	//    surfaces
	registry.complete(&req1);
	registry.complete(&req2);
	state.controls.set_error(
		SurfaceId::RightPanelDiffTab(row.clone()),
		ControlError::new("git diff failed", true),
	);
	state.controls.set_error(
		SurfaceId::RightPanelFileTab(row.clone()),
		ControlError::new("file listing failed", true),
	);
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(state.panel.diff_status, DiffStatus::Failed, "Loading terminates on failure");
	assert_eq!(state.panel.tree.status, TreeStatus::Failed, "Loading terminates on failure");

	// 4. Retry: clear error and re-register in-flight request
	state
		.controls
		.clear_error(&SurfaceId::RightPanelDiffTab(row.clone()));
	state
		.controls
		.clear_error(&SurfaceId::RightPanelFileTab(row.clone()));
	let req3 = RequestId(1003);
	registry.register(
		req3,
		HostActionKind::RefreshChanges,
		SurfaceId::RightPanelDiffTab(row),
		NOW_MS,
		30_000,
	);
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(state.panel.diff_status, DiffStatus::Loading, "Retry transitions back to Loading");
	assert_eq!(state.panel.tree.status, TreeStatus::Unloaded);

	// 5. Success: snapshot arrives and request completes
	registry.complete(&req3);
	store.domains.changes.set(ChangesView {
		revision:   1,
		repository: Some("/repo".into()),
		scope:      veyyon_desktop_model::ChangeScope::WorkingTree,
		files:      Vec::new(),
		diff:       String::new(),
	});
	store.domains.file_tree =
		Some(FileTreeView { root: "/repo".into(), entries: Vec::new(), truncated: false });
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(state.panel.diff_status, DiffStatus::Loaded);
	assert_eq!(state.panel.tree.status, TreeStatus::Loaded);
}

#[test]
fn panel_opening_requests_changes_and_file_tree_only_when_affirmatively_available() {
	let (mut store, index) = store_with_decisions();

	// 1. Initial / Unknown state: no requests emitted prior to host capability
	//    confirmation
	assert_eq!(*store.capabilities.get(Capability::Changes), CapabilityStatus::UnknownUntilAttached);
	assert_eq!(*store.capabilities.get(Capability::Files), CapabilityStatus::UnknownUntilAttached);
	assert!(
		actions_for(&Intent::SetPanel { open: true }, &index, &mut store).is_empty(),
		"opening panel with UnknownUntilAttached capabilities emits no requests"
	);

	// 2. Affirmative Available state: requests are emitted
	store
		.capabilities
		.set(Capability::Changes, CapabilityStatus::Available);
	store
		.capabilities
		.set(Capability::Files, CapabilityStatus::Available);
	assert_eq!(
		actions_for(&Intent::SetPanel { open: true }, &index, &mut store),
		[HostAction::RefreshChanges, HostAction::LoadFileTree { root: None }],
		"opening panel with Available capabilities requests changes and file tree"
	);
	assert!(
		actions_for(&Intent::SetPanel { open: false }, &index, &mut store).is_empty(),
		"closing panel is local-only with no egress"
	);

	// 3. Unavailable state: omitted from actions
	store
		.capabilities
		.set(Capability::Files, CapabilityStatus::Unavailable {
			reason: "no filesystem access".into(),
		});
	assert_eq!(
		actions_for(&Intent::SetPanel { open: true }, &index, &mut store),
		[HostAction::RefreshChanges],
		"unavailable file capability is not requested"
	);

	store
		.capabilities
		.set(Capability::Changes, CapabilityStatus::Unavailable { reason: "git disabled".into() });
	assert!(
		actions_for(&Intent::SetPanel { open: true }, &index, &mut store).is_empty(),
		"opening panel with all capabilities unavailable emits no requests truthfully"
	);

	// 4. Panel projection when capabilities are unavailable exposes no active tabs
	//    rather than infinite loading
	let projected =
		project_panel(&Domains::default(), &store.capabilities, None, PanelContent::default());
	assert!(projected.tabs.is_empty(), "unavailable capabilities result in no enabled panel tabs");
	assert_eq!(projected.tree.status, TreeStatus::Failed);
	assert_eq!(projected.diff_status, DiffStatus::Failed);
	assert_eq!(projected.unavailable_reason.as_deref(), Some("git disabled"));
}

#[test]
fn panel_revealing_intents_uncollapse_panel_locally() {
	let mut state = ShellState::default();
	state.keymap.panel_collapsed = true;

	Intent::OpenFile("src/lib.rs".into()).apply(&mut state);
	assert!(!state.keymap.panel_collapsed, "OpenFile uncollapses panel");
	assert_eq!(state.panel.active_tab, veyyon_desktop_surface::PanelTab::File);
	assert_eq!(state.panel.tree.selected_path, Some("src/lib.rs".into()));

	state.keymap.panel_collapsed = true;
	Intent::SelectChangeScope(veyyon_desktop_model::ChangeScope::Staged).apply(&mut state);
	assert!(!state.keymap.panel_collapsed, "SelectChangeScope uncollapses panel");
	assert_eq!(state.panel.active_tab, veyyon_desktop_surface::PanelTab::Diff);

	state.keymap.panel_collapsed = true;
	state.panel.tabs =
		vec![veyyon_desktop_surface::PanelTab::Diff, veyyon_desktop_surface::PanelTab::Tree];
	Intent::SelectTab(veyyon_desktop_surface::PanelTab::Tree).apply(&mut state);
	assert!(!state.keymap.panel_collapsed, "SelectTab uncollapses panel");
	assert_eq!(state.panel.active_tab, veyyon_desktop_surface::PanelTab::Tree);

	Intent::SetPanel { open: false }.apply(&mut state);
	assert!(state.keymap.panel_collapsed, "SetPanel(false) collapses panel");

	Intent::SetPanel { open: true }.apply(&mut state);
	assert!(!state.keymap.panel_collapsed, "SetPanel(true) uncollapses panel");
}
