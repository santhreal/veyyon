//! From the capability map to what each control may do (§1.2, §4.3).
//!
//! A control never decides its own availability: it reads
//! `ControlStates::availability` and draws what it is told. This is the one
//! place that decision is made, for every control that reads it. A control
//! whose capability the host reported `Unavailable` draws muted with the
//! host's reason; one whose request is in flight draws pending; one the host
//! has not answered for draws at rest, because a disabled control before
//! attach states something false.
//!
//! Every gate is then narrowed by the transport (`transport_gate`, §8.12),
//! because the capability map holds what the host declared while it was
//! reachable and says nothing about whether it still is.
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ErrorScope, HostActionKind, RequestRegistry, SessionId, Store,
	SurfaceId, fallback_surface, gate_kind,
};
use veyyon_desktop_surface::{Availability, DiffStatus, ShellState, TreeStatus};

use super::{
	SessionIndex,
	connection::{transport_gate, transport_gate_capability},
};

/// Resolves the initiating contextual surface for a background or panel host
/// action.
#[must_use]
pub fn contextual_surface_for_action(
	action: HostActionKind,
	session: &SessionId,
) -> Option<SurfaceId> {
	match action {
		HostActionKind::RefreshChanges => Some(SurfaceId::RightPanelDiffTab(session.clone())),
		HostActionKind::LoadFileTree | HostActionKind::ReadFile => {
			Some(SurfaceId::RightPanelFileTab(session.clone()))
		},
		HostActionKind::SelectChangeScope => {
			Some(SurfaceId::RightPanelChangeScopeSelector(session.clone()))
		},
		_ => None,
	}
}

/// The row the composer draws for: the active session's, or zero when none
/// is open, which is the id of no session and the id the composer reads.
fn composer_row(active_row: Option<u64>) -> SessionId {
	SessionId::from(active_row.unwrap_or(0).to_string())
}

/// The composer's own controls, with the action each would send.
fn composer_controls(row: &SessionId) -> [(SurfaceId, HostActionKind); 9] {
	[
		(SurfaceId::ComposerSendButton(row.clone()), HostActionKind::SubmitPrompt),
		(SurfaceId::ComposerSteerButton(row.clone()), HostActionKind::Steer),
		(SurfaceId::ComposerQueueButton(row.clone()), HostActionKind::FollowUp),
		(SurfaceId::ComposerAbortButton(row.clone()), HostActionKind::AbortTurn),
		(
			SurfaceId::ComposerCancelToolButton(row.clone(), "bash".to_string()),
			HostActionKind::CancelTool,
		),
		(SurfaceId::ComposerQueueModeToggle(row.clone()), HostActionKind::SetQueueMode),
		(SurfaceId::ComposerModelSelector(row.clone()), HostActionKind::SelectModel),
		(SurfaceId::ComposerThinkingSelector(row.clone()), HostActionKind::SetThinkingLevel),
		(SurfaceId::ComposerQueuedTakeBack(row.clone()), HostActionKind::DequeueQueuedPrompt),
	]
}

/// Every control that reads its availability, with the action it would send.
///
/// Derived from the store's domains at each projection, so a provider, server,
/// setting or binding the host adds on the next snapshot is gated on the frame
/// that shows it. The composer's primary action answers the first pending
/// card of each kind under that card's id (`TurnPhase::primary_surface`), so
/// those ids are gated by the answer they would send.
pub fn gated_controls(store: &Store, active_row: Option<u64>) -> Vec<(SurfaceId, HostActionKind)> {
	let mut controls = vec![
		(SurfaceId::NewSessionButton, HostActionKind::CreateSession),
		(SurfaceId::ConnectionRetryButton, HostActionKind::RetryConnection),
		(SurfaceId::ThemeSelector, HostActionKind::LoadThemes),
		(SurfaceId::DiagnosticRefreshButton, HostActionKind::RefreshDiagnostics),
		(SurfaceId::UsageRefreshButton, HostActionKind::GetUsage),
		(SurfaceId::ContextBreakdownRefreshButton, HostActionKind::GetContextBreakdown),
		(SurfaceId::TaskSpawnButton, HostActionKind::SpawnTask),
		(SurfaceId::SettingsField("providers".to_string()), HostActionKind::RefreshProviders),
	];
	if active_row.is_some() {
		let row = composer_row(active_row);
		controls.extend(composer_controls(&row));
		controls.extend([
			(SurfaceId::QueueSessionRow(row.clone()), HostActionKind::LoadTranscript),
			(SurfaceId::QueueDeleteButton(row.clone()), HostActionKind::DeleteSession),
			(SurfaceId::SessionBranchButton(row.clone()), HostActionKind::BranchSession),
			(SurfaceId::SessionRenameField(row.clone()), HostActionKind::RenameSession),
			(SurfaceId::SessionExportButton(row.clone()), HostActionKind::ExportSession),
			(SurfaceId::SessionCompactButton(row.clone()), HostActionKind::CompactSession),
			(SurfaceId::SessionHandoffButton(row.clone()), HostActionKind::HandoffSession),
			(SurfaceId::RightPanelDiffTab(row.clone()), HostActionKind::RefreshChanges),
			(SurfaceId::RightPanelFileTab(row.clone()), HostActionKind::LoadFileTree),
			(SurfaceId::RightPanelChangeScopeSelector(row.clone()), HostActionKind::SelectChangeScope),
			(SurfaceId::TerminalCreateButton(row.clone()), HostActionKind::CreateTerminal),
		]);
		let pending = store
			.persisted
			.shell
			.active_session
			.as_ref()
			.and_then(|id| store.interactions.get(id));
		if let Some(pending) = pending {
			let answer = HostActionKind::RespondToInteraction;
			controls.extend(pending.approvals.first().map(|approval| {
				(SurfaceId::ApprovalApproveButton(row.clone(), approval.id.clone()), answer)
			}));
			controls.extend(pending.questions.first().map(|question| {
				(SurfaceId::QuestionSubmitButton(row.clone(), question.id.clone()), answer)
			}));
			controls.extend(pending.plans.first().into_iter().flat_map(|plan| {
				[
					(SurfaceId::PlanAcceptButton(row.clone(), plan.id.clone()), answer),
					(SurfaceId::PlanRefineButton(row.clone(), plan.id.clone()), answer),
				]
			}));
		}
	}

	let domains = &store.domains;
	if let Some(settings) = &domains.settings {
		controls.extend(
			settings
				.keys()
				.map(|key| (SurfaceId::SettingsField(key.clone()), HostActionKind::SetSetting)),
		);
	}
	controls.extend(domains.keybindings.iter().map(|binding| {
		(SurfaceId::KeybindingField(binding.action.clone()), HostActionKind::SetKeybinding)
	}));
	controls.extend(domains.providers.iter().map(|provider| {
		(SurfaceId::ProviderAuthStartButton(provider.id.clone()), HostActionKind::StartProviderAuth)
	}));
	controls.extend(domains.mcp.iter().map(|server| {
		(SurfaceId::McpEnableToggle(server.name.clone()), HostActionKind::SetMcpEnabled)
	}));
	if let Some(row_id) = active_row {
		let row = composer_row(Some(row_id));
		controls.extend(domains.terminals.iter().flat_map(|term| {
			[
				(
					SurfaceId::TerminalClearButton(row.clone(), term.id.clone()),
					HostActionKind::ClearTerminal,
				),
				(
					SurfaceId::TerminalRestartButton(row.clone(), term.id.clone()),
					HostActionKind::RestartTerminal,
				),
				(
					SurfaceId::TerminalCloseButton(row.clone(), term.id.clone()),
					HostActionKind::CloseTerminal,
				),
			]
		}));
		controls.extend(domains.processes.iter().flat_map(|proc| {
			[
				(
					SurfaceId::ProcessStopButton(row.clone(), proc.name.clone()),
					HostActionKind::ProcessStop,
				),
				(
					SurfaceId::ProcessRestartButton(row.clone(), proc.name.clone()),
					HostActionKind::ProcessRestart,
				),
				(
					SurfaceId::ProcessLogsTab(row.clone(), proc.name.clone()),
					HostActionKind::ProcessLogs,
				),
			]
		}));
	}
	controls.extend(domains.agents.iter().flat_map(|agent| {
		[
			(SurfaceId::AgentReviveButton(agent.id.clone()), HostActionKind::ReviveAgent),
			(SurfaceId::TaskCancelButton(agent.id.clone()), HostActionKind::CancelTask),
		]
	}));
	controls
}

/// What the composer's controls read while no session is open: the intent
/// path sends nothing for them (`actions_for`), so the control states that
/// rather than drawing at rest.
pub const NO_SESSION_OPEN: &str = "no session is open";

/// Sets every gated control's availability from the capability map and the
/// in-flight registry.
///
/// The registry is the one source of a pending mark, so a request the host
/// answered releases its control on the next projection. With no session
/// open the composer still draws, under the row id of no session, and its
/// controls are unavailable for that reason rather than unset.
pub fn project_controls(
	store: &Store,
	registry: &RequestRegistry,
	index: &SessionIndex,
	state: &mut ShellState,
) {
	let active_row = store
		.persisted
		.shell
		.active_session
		.as_ref()
		.and_then(|id| index.row_id(id));
	for (surface, action) in gated_controls(store, active_row) {
		let gate = transport_gate(
			action,
			&store.connection,
			gate_kind(action, &store.capabilities, registry),
		);
		state
			.controls
			.set_availability(surface, Availability::from(gate));
	}
	if let Some(active_id) = store.persisted.shell.active_session.as_ref()
		&& let Some(row_id) = active_row
	{
		let row = composer_row(Some(row_id));
		if let Some(pending) = store.interactions.get(active_id) {
			if let Some(question) = pending.questions.first() {
				let gate = transport_gate(
					HostActionKind::RespondToInteraction,
					&store.connection,
					veyyon_desktop_model::gate_capability(
						Capability::Questions,
						&store.capabilities,
						registry,
					),
				);
				state.controls.set_availability(
					SurfaceId::QuestionSubmitButton(row.clone(), question.id.clone()),
					Availability::from(gate),
				);
			}
			if let Some(plan) = pending.plans.first() {
				let gate = transport_gate(
					HostActionKind::RespondToInteraction,
					&store.connection,
					veyyon_desktop_model::gate_capability(
						Capability::Plans,
						&store.capabilities,
						registry,
					),
				);
				state.controls.set_availability(
					SurfaceId::PlanAcceptButton(row.clone(), plan.id.clone()),
					Availability::from(gate.clone()),
				);
				state.controls.set_availability(
					SurfaceId::PlanRefineButton(row, plan.id.clone()),
					Availability::from(gate),
				);
			}
		}
	}
	let ext_gate = transport_gate_capability(
		&store.connection,
		veyyon_desktop_model::gate_capability(
			veyyon_desktop_model::Capability::Extensions,
			&store.capabilities,
			registry,
		),
	);
	state.controls.set_availability(
		SurfaceId::SettingsField("extensions".to_string()),
		Availability::from(ext_gate),
	);
	if matches!(
		store.capabilities.get(Capability::BackgroundSubmission),
		CapabilityStatus::Unavailable { .. }
	) && let Some(row_id) = active_row
	{
		let row = composer_row(Some(row_id));
		state
			.controls
			.set_availability(SurfaceId::ComposerQueueModeToggle(row), Availability::Unavailable {
				reason: "background submission unavailable".to_string(),
			});
	}
	if active_row.is_none() {
		let row = composer_row(active_row);
		for (surface, _) in composer_controls(&row) {
			state
				.controls
				.set_availability(surface, Availability::Unavailable {
					reason: NO_SESSION_OPEN.to_string(),
				});
		}
		for surface in [
			SurfaceId::RightPanelDiffTab(row.clone()),
			SurfaceId::RightPanelFileTab(row.clone()),
			SurfaceId::RightPanelChangeScopeSelector(row),
		] {
			state
				.controls
				.set_availability(surface, Availability::Unavailable {
					reason: NO_SESSION_OPEN.to_string(),
				});
		}
	}

	let active_id = store.persisted.shell.active_session.as_ref();
	let row = composer_row(active_row);
	// Contextual status resolution for Changes / Diff
	let diff_pending = registry
		.find_pending_for_action(HostActionKind::RefreshChanges)
		.is_some()
		|| registry
			.find_pending_for_capability(Capability::Changes)
			.is_some();
	let has_changes = store.domains.changes.is_some();
	let diff_unavailable =
		matches!(store.capabilities.get(Capability::Changes), CapabilityStatus::Unavailable { .. });
	let diff_error = state
		.controls
		.error(&SurfaceId::RightPanelDiffTab(row.clone()))
		.is_some()
		|| active_id.is_some_and(|s| {
			state
				.controls
				.error(&SurfaceId::RightPanelDiffTab(s.clone()))
				.is_some()
		}) || state
		.controls
		.error(&fallback_surface(ErrorScope::Change, active_id))
		.is_some();

	state.panel.diff_status = if diff_pending {
		DiffStatus::Loading
	} else if has_changes {
		DiffStatus::Loaded
	} else if diff_unavailable || diff_error {
		DiffStatus::Failed
	} else {
		DiffStatus::Unloaded
	};

	// Contextual status resolution for FileTree / Tree
	let tree_pending = registry
		.find_pending_for_action(HostActionKind::LoadFileTree)
		.is_some()
		|| registry
			.find_pending_for_capability(Capability::Files)
			.is_some();
	let has_tree = store.domains.file_tree.is_some();
	let tree_unavailable =
		matches!(store.capabilities.get(Capability::Files), CapabilityStatus::Unavailable { .. });
	let tree_error = state
		.controls
		.error(&SurfaceId::RightPanelFileTab(row))
		.is_some()
		|| active_id.is_some_and(|s| {
			state
				.controls
				.error(&SurfaceId::RightPanelFileTab(s.clone()))
				.is_some()
		}) || state
		.controls
		.error(&fallback_surface(ErrorScope::File, active_id))
		.is_some();

	state.panel.tree.status = if tree_pending {
		TreeStatus::Loading
	} else if has_tree {
		TreeStatus::Loaded
	} else if tree_unavailable || tree_error {
		TreeStatus::Failed
	} else {
		TreeStatus::Unloaded
	};
}
