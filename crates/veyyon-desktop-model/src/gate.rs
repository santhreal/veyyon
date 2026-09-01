use serde::{Deserialize, Serialize};

use crate::{
	action::{HostAction, HostActionKind},
	capabilities::{Capability, CapabilityMap, CapabilityStatus},
	connection::RequestId,
	registry::RequestRegistry,
};

/// Tri-state resolution for UI control availability including in-flight
/// requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Gate {
	Enabled,
	Pending { request: RequestId },
	Unavailable { reason: String },
	Unknown,
}

/// Resolves the protocol capability required by a given action kind.
#[must_use]
pub const fn action_to_capability(action: HostActionKind) -> Capability {
	match action {
		HostActionKind::Attach => Capability::Lifecycle,
		HostActionKind::Detach => Capability::Lifecycle,
		HostActionKind::RetryConnection => Capability::Lifecycle,
		HostActionKind::Shutdown => Capability::Lifecycle,
		HostActionKind::ListSessions => Capability::Sessions,
		HostActionKind::OpenSession => Capability::Sessions,
		HostActionKind::CreateSession => Capability::Sessions,
		HostActionKind::RenameSession => Capability::Sessions,
		HostActionKind::DeleteSession => Capability::SessionDeletion,
		HostActionKind::BranchSession => Capability::SessionTreeNavigation,
		HostActionKind::ExportSession => Capability::Sessions,
		HostActionKind::CompactSession => Capability::Sessions,
		HostActionKind::HandoffSession => Capability::Sessions,
		HostActionKind::LoadTranscript => Capability::Transcript,
		HostActionKind::SubmitPrompt => Capability::TurnControl,
		HostActionKind::Steer => Capability::TurnControl,
		HostActionKind::FollowUp => Capability::TurnControl,
		HostActionKind::AbortTurn => Capability::TurnControl,
		HostActionKind::SetQueueMode => Capability::TurnControl,
		HostActionKind::CancelTool => Capability::Tools,
		HostActionKind::RespondToInteraction => Capability::Approvals,
		HostActionKind::LoadFileTree => Capability::Files,
		HostActionKind::ReadFile => Capability::Files,
		HostActionKind::SearchFiles => Capability::Files,
		HostActionKind::OpenExternal => Capability::Files,
		HostActionKind::RefreshChanges => Capability::Changes,
		HostActionKind::SelectChangeScope => Capability::Changes,
		HostActionKind::CreateTerminal => Capability::Terminals,
		HostActionKind::AttachTerminal => Capability::Terminals,
		HostActionKind::WriteTerminal => Capability::Terminals,
		HostActionKind::ResizeTerminal => Capability::Terminals,
		HostActionKind::RestartTerminal => Capability::Terminals,
		HostActionKind::ClearTerminal => Capability::Terminals,
		HostActionKind::CloseTerminal => Capability::Terminals,
		HostActionKind::RefreshProcesses => Capability::ProcessSupervisor,
		HostActionKind::ProcessLogs => Capability::ProcessSupervisor,
		HostActionKind::ProcessSend => Capability::ProcessSupervisor,
		HostActionKind::ProcessSignal => Capability::ProcessSupervisor,
		HostActionKind::ProcessStop => Capability::ProcessSupervisor,
		HostActionKind::ProcessRestart => Capability::ProcessSupervisor,
		HostActionKind::ProcessStart => Capability::ProcessSupervisor,
		HostActionKind::ProcessWait => Capability::ProcessSupervisor,
		HostActionKind::ProcessDescribe => Capability::ProcessSupervisor,
		HostActionKind::RefreshModels => Capability::Models,
		HostActionKind::SelectModel => Capability::Models,
		HostActionKind::SetThinkingLevel => Capability::Models,
		HostActionKind::RefreshProviders => Capability::Providers,
		HostActionKind::StartProviderAuth => Capability::Authentication,
		HostActionKind::RefreshAuth => Capability::Authentication,
		HostActionKind::SubmitAuthSecret => Capability::Authentication,
		HostActionKind::OpenAuthUrl => Capability::Authentication,
		HostActionKind::CancelAuthFlow => Capability::Authentication,
		HostActionKind::RetryAuthFlow => Capability::Authentication,
		HostActionKind::RefreshMcp => Capability::Mcp,
		HostActionKind::ConnectMcp => Capability::Mcp,
		HostActionKind::DisconnectMcp => Capability::Mcp,
		HostActionKind::SetMcpEnabled => Capability::Mcp,
		HostActionKind::CallMcpTool => Capability::Mcp,
		HostActionKind::ReviveAgent => Capability::Agents,
		HostActionKind::SpawnTask => Capability::Tasks,
		HostActionKind::CancelTask => Capability::Tasks,
		HostActionKind::LoadSettings => Capability::Settings,
		HostActionKind::SetSetting => Capability::Settings,
		HostActionKind::ResetSetting => Capability::Settings,
		HostActionKind::LoadThemes => Capability::Themes,
		HostActionKind::LoadKeybindings => Capability::Keybindings,
		HostActionKind::SetKeybinding => Capability::Keybindings,
		HostActionKind::RefreshDiagnostics => Capability::Diagnostics,
		HostActionKind::RetryDiagnosticSource => Capability::Diagnostics,
		HostActionKind::ClearOutput => Capability::Sessions,
		HostActionKind::GetUsage => Capability::Usage,
		HostActionKind::GetContextBreakdown => Capability::ContextBreakdown,
	}
}

/// Evaluates the capability gate for a concrete host action against active
/// capabilities and pending requests.
#[must_use]
pub fn gate(action: &HostAction, capabilities: &CapabilityMap, registry: &RequestRegistry) -> Gate {
	gate_kind(action.kind(), capabilities, registry)
}

/// Evaluates the capability gate for an action kind against active capabilities
/// and pending requests.
#[must_use]
pub fn gate_kind(
	action: HostActionKind,
	capabilities: &CapabilityMap,
	registry: &RequestRegistry,
) -> Gate {
	if let Some(request) = registry.find_pending_for_action(action) {
		return Gate::Pending { request };
	}

	let capability = action_to_capability(action);
	match capabilities.get(capability) {
		CapabilityStatus::Available => Gate::Enabled,
		CapabilityStatus::Unavailable { reason } => Gate::Unavailable { reason: reason.clone() },
		CapabilityStatus::UnknownUntilAttached => Gate::Unknown,
	}
}
