//! Action and surface target mappings for capability gates (§1.2, §4.3, §9.5).

use veyyon_desktop_model::{Capability, HostActionKind, InteractionId, SessionId, SurfaceId};

/// Resolves the primary host action kind gated by a given capability.
#[must_use]
pub const fn action_of(capability: Capability) -> Option<HostActionKind> {
	match capability {
		Capability::Lifecycle => Some(HostActionKind::RetryConnection),
		Capability::Sessions => Some(HostActionKind::CreateSession),
		Capability::SessionDeletion => Some(HostActionKind::DeleteSession),
		Capability::SessionTreeNavigation => Some(HostActionKind::BranchSession),
		Capability::Transcript => Some(HostActionKind::LoadTranscript),
		Capability::TurnControl => Some(HostActionKind::SubmitPrompt),
		Capability::Tools => Some(HostActionKind::CancelTool),
		Capability::Approvals => Some(HostActionKind::RespondToInteraction),
		Capability::Files => Some(HostActionKind::LoadFileTree),
		Capability::Changes => Some(HostActionKind::RefreshChanges),
		Capability::Terminals => Some(HostActionKind::ClearTerminal),
		Capability::ProcessSupervisor => Some(HostActionKind::ProcessStop),
		Capability::Models => Some(HostActionKind::SelectModel),
		Capability::Providers => Some(HostActionKind::RefreshProviders),
		Capability::Authentication => Some(HostActionKind::StartProviderAuth),
		Capability::Mcp => Some(HostActionKind::SetMcpEnabled),
		Capability::Agents => Some(HostActionKind::ReviveAgent),
		Capability::Tasks => Some(HostActionKind::CancelTask),
		Capability::Settings => Some(HostActionKind::SetSetting),
		Capability::Themes => Some(HostActionKind::LoadThemes),
		Capability::Keybindings => Some(HostActionKind::SetKeybinding),
		Capability::Diagnostics => Some(HostActionKind::RefreshDiagnostics),
		Capability::Usage => Some(HostActionKind::GetUsage),
		Capability::ContextBreakdown => Some(HostActionKind::GetContextBreakdown),
		Capability::Questions
		| Capability::Plans
		| Capability::Extensions
		| Capability::AgentCommands
		| Capability::PendingEdits
		| Capability::BackgroundSubmission => None,
	}
}

/// Resolves the concrete interactive control surface ID associated with a
/// capability.
#[must_use]
pub fn target_surface_of(capability: Capability, _session: &SessionId) -> SurfaceId {
	let row = SessionId::from("1");
	match capability {
		Capability::Lifecycle => SurfaceId::ConnectionRetryButton,
		Capability::Sessions => SurfaceId::NewSessionButton,
		Capability::SessionDeletion => SurfaceId::QueueDeleteButton(SessionId::from("2")),
		Capability::SessionTreeNavigation => SurfaceId::SessionBranchButton(SessionId::from("2")),
		Capability::Transcript => SurfaceId::QueueSessionRow(row),
		Capability::TurnControl => SurfaceId::ComposerSendButton(row),
		Capability::Tools => SurfaceId::ComposerCancelToolButton(row, "bash".to_string()),
		Capability::Approvals => {
			SurfaceId::ApprovalApproveButton(row, InteractionId::from("approval_0001"))
		},
		Capability::Questions => {
			SurfaceId::QuestionSubmitButton(row, InteractionId::from("question_0001"))
		},
		Capability::Plans => SurfaceId::PlanAcceptButton(row, InteractionId::from("plan_0001")),
		Capability::Files => SurfaceId::RightPanelFileTab(row),
		Capability::Changes | Capability::PendingEdits => SurfaceId::RightPanelDiffTab(row),
		Capability::Terminals => SurfaceId::TerminalClearButton(row, "term_1".to_string()),
		Capability::ProcessSupervisor => {
			SurfaceId::ProcessStopButton(row, "build-server".to_string())
		},
		Capability::Models => SurfaceId::ComposerModelSelector(row),
		Capability::Providers => SurfaceId::SettingsField("providers".to_string()),
		Capability::Authentication => SurfaceId::ProviderAuthStartButton("anthropic".to_string()),
		Capability::Mcp => SurfaceId::McpEnableToggle("filesystem".to_string()),
		Capability::Extensions => SurfaceId::SettingsField("extensions".to_string()),
		Capability::Tasks => SurfaceId::TaskCancelButton("runner".to_string()),
		Capability::Agents => SurfaceId::AgentReviveButton("cr".to_string()),
		Capability::AgentCommands => SurfaceId::PaletteInput,
		Capability::Settings => SurfaceId::SettingsField("ui.compact".to_string()),
		Capability::Themes => SurfaceId::ThemeSelector,
		Capability::Keybindings => SurfaceId::KeybindingField("NewSession".to_string()),
		Capability::Diagnostics => SurfaceId::DiagnosticRefreshButton,
		Capability::Usage => SurfaceId::UsageRefreshButton,
		Capability::ContextBreakdown => SurfaceId::ContextBreakdownRefreshButton,
		Capability::BackgroundSubmission => SurfaceId::ComposerQueueModeToggle(row),
	}
}
