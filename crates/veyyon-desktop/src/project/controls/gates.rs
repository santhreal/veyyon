//! Which control reads which action's gate (§1.2, §4.3).
//!
//! Every interactive surface that reads `ControlStates::availability` is named
//! here, with the action it would send. The set is derived from the store at
//! each projection rather than written down once, so a provider, server,
//! setting, binding or session the host adds is gated on the frame that draws
//! it.

use veyyon_desktop_model::{
	DiagnosticSource, HostActionKind, SessionId, Store, SurfaceId, diagnostic_sources,
};

use crate::project::SessionIndex;

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
pub fn composer_row(active_row: Option<u64>) -> SessionId {
	SessionId::from(active_row.unwrap_or(0).to_string())
}

/// The composer's own controls, with the action each would send.
pub fn composer_controls(row: &SessionId) -> [(SurfaceId, HostActionKind); 10] {
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
		(SurfaceId::ComposerGoalChip(row.clone()), HostActionKind::ControlGoal),
	]
}

/// The rows the turn menu offers over the last turn, with the action each
/// would send.
pub fn turn_controls(row: &SessionId) -> [(SurfaceId, HostActionKind); 2] {
	[
		(SurfaceId::SessionRetryButton(row.clone()), HostActionKind::RetryTurn),
		(SurfaceId::SessionRephraseButton(row.clone()), HostActionKind::RephraseReply),
	]
}

/// The answers one queue row offers about its own session: its menu's
/// management items, its delete action, and the field that renames it.
///
/// These belong to every row the rail draws, not to the active one. A row
/// menu opens on the row under the pointer and reads the gate of that row's
/// session, so a set projected for the active session alone leaves every
/// other row reading either nothing or the value the active session left
/// behind (§5.1, §5.13).
pub fn session_row_controls(row: &SessionId) -> [(SurfaceId, HostActionKind); 7] {
	[
		(SurfaceId::QueueSessionRow(row.clone()), HostActionKind::LoadTranscript),
		(SurfaceId::QueueDeleteButton(row.clone()), HostActionKind::DeleteSession),
		(SurfaceId::SessionBranchButton(row.clone()), HostActionKind::BranchSession),
		(SurfaceId::SessionRenameField(row.clone()), HostActionKind::RenameSession),
		(SurfaceId::SessionExportButton(row.clone()), HostActionKind::ExportSession),
		(SurfaceId::SessionCompactButton(row.clone()), HostActionKind::CompactSession),
		(SurfaceId::SessionHandoffButton(row.clone()), HostActionKind::HandoffSession),
	]
}

/// Every control that reads its availability, with the action it would send.
///
/// Derived from the store's domains at each projection, so a provider, server,
/// setting or binding the host adds on the next snapshot is gated on the frame
/// that shows it. The composer's primary action answers the first pending
/// card of each kind under that card's id (`TurnPhase::primary_surface`), so
/// those ids are gated by the answer they would send.
pub fn gated_controls(
	store: &Store,
	index: &SessionIndex,
	active_row: Option<u64>,
) -> Vec<(SurfaceId, HostActionKind)> {
	let mut controls = vec![
		(SurfaceId::NewSessionButton, HostActionKind::CreateSession),
		(SurfaceId::ConnectionRetryButton, HostActionKind::RetryConnection),
		// The freeze belongs to the host process, so both controls are gated
		// whether or not a session is open: a window with nothing open can
		// still be the one that releases agents running behind it.
		(SurfaceId::AgentsPauseButton, HostActionKind::PauseAgents),
		(SurfaceId::AgentsResumeButton, HostActionKind::ResumeAgents),
		// The selector reads the catalogue's gate, which is the capability a
		// host without themes withholds; a refused selection is stated on it
		// by `settings_surface_for_action`, which the gate does not decide.
		(SurfaceId::ThemeSelector, HostActionKind::LoadThemes),
		(SurfaceId::DiagnosticRefreshButton, HostActionKind::RefreshDiagnostics),
		(SurfaceId::UsageRefreshButton, HostActionKind::GetUsage),
		(SurfaceId::ContextBreakdownRefreshButton, HostActionKind::GetContextBreakdown),
		(SurfaceId::TaskSpawnButton, HostActionKind::SpawnTask),
		(SurfaceId::SettingsField("providers".to_string()), HostActionKind::RefreshProviders),
		(SurfaceId::OutputClearButton, HostActionKind::ClearOutput),
		// The palette's field is the control every host command rides on: one
		// request runs a command, so the field states the gate of running one.
		(SurfaceId::PaletteInput, HostActionKind::RunCommand),
		// A share is the window's, not a row's: the card is reached with no
		// session open, and the host opens one for the share it starts.
		(SurfaceId::ShareStartButton, HostActionKind::StartShare),
		(SurfaceId::ShareStartReadOnlyButton, HostActionKind::StartShare),
		(SurfaceId::ShareStopButton, HostActionKind::StopShare),
		(SurfaceId::ShareRefreshButton, HostActionKind::RefreshShare),
		// A profile is the process's, not a session's: the page is reached
		// with nothing open, and the host serves the profile it was started
		// under whatever the window has in front of it.
		(SurfaceId::ProfileCreateButton, HostActionKind::CreateProfile),
		(SurfaceId::ProfileRefreshButton, HostActionKind::RefreshProfiles),
	];
	// One rename and one delete per profile the host listed, keyed by the
	// directory they act on, so a refusal lands on the row that sent it.
	controls.extend(
		store
			.domains
			.profiles
			.iter()
			.flat_map(|profiles| profiles.entries.iter())
			.flat_map(|entry| {
				[
					(SurfaceId::ProfileRenameButton(entry.name.clone()), HostActionKind::RenameProfile),
					(SurfaceId::ProfileDeleteButton(entry.name.clone()), HostActionKind::DeleteProfile),
				]
			}),
	);
	// Every session the rail can draw a row for, and the active one, which the
	// host may not have listed yet.
	controls.extend(
		store
			.sessions
			.items
			.keys()
			.filter_map(|id| index.row_id(id))
			.chain(active_row)
			.flat_map(|row| session_row_controls(&SessionId::from(row.to_string()))),
	);
	if active_row.is_some() {
		let row = composer_row(active_row);
		controls.extend(composer_controls(&row));
		controls.extend([
			(SurfaceId::RightPanelDiffTab(row.clone()), HostActionKind::RefreshChanges),
			(SurfaceId::RightPanelFileTab(row.clone()), HostActionKind::LoadFileTree),
			(SurfaceId::RightPanelChangeScopeSelector(row.clone()), HostActionKind::SelectChangeScope),
			(SurfaceId::TerminalCreateButton(row.clone()), HostActionKind::CreateTerminal),
			(SurfaceId::ProcessStartButton(row.clone()), HostActionKind::ProcessStart),
			// The plan belongs to the open session, and it is read again
			// from the file the agent wrote rather than from a turn, so it
			// is gated with the session's controls and not the turn menu's.
			(SurfaceId::SessionPlanReviewButton(row.clone()), HostActionKind::ReviewPlan),
		]);
		// The turn menu's own two: both act on the session's last turn, so
		// they are the active session's and not a rail row's.
		controls.extend(turn_controls(&row));
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
	// A source the host reports in error draws its own `Retry`, which reads
	// its own gate: one source re-running holds that row, not the page.
	controls.extend(
		diagnostic_sources(domains.diagnostics.as_ref())
			.into_iter()
			.filter(DiagnosticSource::offers_retry)
			.map(|source| {
				(
					SurfaceId::DiagnosticRetrySourceButton(source.name.to_owned()),
					HostActionKind::RetryDiagnosticSource,
				)
			}),
	);
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
				(
					SurfaceId::ProcessSendButton(row.clone(), proc.name.clone()),
					HostActionKind::ProcessSend,
				),
				(
					SurfaceId::ProcessSignalButton(row.clone(), proc.name.clone()),
					HostActionKind::ProcessSignal,
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
