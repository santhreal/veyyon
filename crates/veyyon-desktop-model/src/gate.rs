use serde::{Deserialize, Serialize};

use crate::{
	action::{HostAction, HostActionKind},
	capabilities::{Capability, CapabilityMap, CapabilityStatus},
	connection::{ConnectionState, RequestId},
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
		HostActionKind::PauseAgents => Capability::Lifecycle,
		HostActionKind::ResumeAgents => Capability::Lifecycle,
		HostActionKind::ListSessions => Capability::Sessions,
		HostActionKind::SearchSessions => Capability::Sessions,
		HostActionKind::PreviewSessionTranscript => Capability::Transcript,
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
		// Moving a running command off the turn needs a host that supervises
		// background jobs, which a host answering turns need not do: one that
		// runs every command to completion honours the rest of the family and
		// withholds this.
		HostActionKind::BackgroundCommand => Capability::ForegroundCommand,
		HostActionKind::RetryTurn => Capability::TurnControl,
		HostActionKind::RephraseReply => Capability::TurnControl,
		// What it asks for is a decision card, so it needs the capability
		// that answers one: a host that cannot take an answer would raise a
		// plan nobody could accept or send back.
		HostActionKind::ReviewPlan => Capability::Approvals,
		HostActionKind::SetQueueMode => Capability::TurnControl,
		// A mode is the session's, not the turn's: it survives the turn that
		// was running when it was entered, and a host with no turn in flight
		// still answers it.
		HostActionKind::SetSessionMode => Capability::Sessions,
		HostActionKind::CancelTool => Capability::Tools,
		HostActionKind::SetToolViewExpanded => Capability::Tools,
		HostActionKind::DequeueQueuedPrompt => Capability::TurnControl,
		HostActionKind::RespondToInteraction => Capability::Approvals,
		HostActionKind::LoadFileTree => Capability::Files,
		HostActionKind::ReadFile => Capability::Files,
		HostActionKind::SearchFiles => Capability::Files,
		HostActionKind::SearchContent => Capability::Files,
		HostActionKind::SearchPromptHistory => Capability::PromptHistory,
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
		HostActionKind::RefreshModels => Capability::Models,
		HostActionKind::SelectModel => Capability::Models,
		HostActionKind::SetThinkingLevel => Capability::Models,
		HostActionKind::RefreshProviders => Capability::Providers,
		HostActionKind::StartProviderAuth => Capability::Authentication,
		HostActionKind::SubmitAuthSecret => Capability::Authentication,
		HostActionKind::OpenAuthUrl => Capability::Authentication,
		HostActionKind::CancelAuthFlow => Capability::Authentication,
		HostActionKind::RetryAuthFlow => Capability::Authentication,
		HostActionKind::RefreshMcp => Capability::Mcp,
		HostActionKind::SetMcpEnabled => Capability::Mcp,
		HostActionKind::AddMcpServer => Capability::Mcp,
		HostActionKind::RemoveMcpServer => Capability::Mcp,
		HostActionKind::TestMcpServer => Capability::Mcp,
		HostActionKind::ReauthMcpServer => Capability::Mcp,
		HostActionKind::ClearMcpServerAuth => Capability::Mcp,
		HostActionKind::ReloadMcp => Capability::Mcp,
		HostActionKind::SearchMcpRegistry => Capability::Mcp,
		HostActionKind::DeployMcpRegistryServer => Capability::Mcp,
		HostActionKind::LoginMcpRegistry => Capability::Mcp,
		HostActionKind::LogoutMcpRegistry => Capability::Mcp,
		HostActionKind::RefreshAgents => Capability::Agents,
		HostActionKind::ReviveAgent => Capability::Agents,
		HostActionKind::SpawnTask => Capability::Tasks,
		HostActionKind::CancelTask => Capability::Tasks,
		HostActionKind::ListCommands => Capability::AgentCommands,
		HostActionKind::RunCommand => Capability::AgentCommands,
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
		HostActionKind::SetGoal => Capability::Goals,
		HostActionKind::ControlGoal => Capability::Goals,
		HostActionKind::StartShare
		| HostActionKind::StopShare
		| HostActionKind::RefreshShare
		| HostActionKind::JoinShare
		| HostActionKind::LeaveShare => Capability::Share,
		HostActionKind::RefreshProfiles
		| HostActionKind::CreateProfile
		| HostActionKind::RenameProfile
		| HostActionKind::DeleteProfile => Capability::Profiles,
		HostActionKind::ToggleDictation | HostActionKind::CancelDictation => Capability::Dictation,
		// The console is one surface: a host that draws none of it withholds
		// the capability, and every request that reaches into it is held back
		// together rather than a row being settable on a console that cannot
		// be run.
		HostActionKind::SetAutoswarmField
		| HostActionKind::RunAutoswarmAction
		| HostActionKind::SaveAutoswarmPreset
		| HostActionKind::DeleteAutoswarmPreset
		| HostActionKind::CloseAutoswarmConsole => Capability::Autoswarm,
		HostActionKind::SignOutAccount => Capability::Authentication,
		HostActionKind::RefreshExtensions
		| HostActionKind::SetExtensionEnabled
		| HostActionKind::SetExtensionSourceEnabled => Capability::Extensions,
		// The draft and the completions are read by the session's extensions,
		// so a host that loads none withholds both with the rest of them.
		HostActionKind::ReportComposerDraft | HostActionKind::CompleteComposer => {
			Capability::Extensions
		},
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
///
/// A capability the host refused is unavailable whatever is in flight: the
/// request in flight meets the same refusal, and a pending state would hide
/// the host's reason.
#[must_use]
pub fn gate_kind(
	action: HostActionKind,
	capabilities: &CapabilityMap,
	registry: &RequestRegistry,
) -> Gate {
	let capability = action_to_capability(action);
	let refused = matches!(capabilities.get(capability), CapabilityStatus::Unavailable { .. });
	match registry.find_pending_for_action(action) {
		Some(request) if !refused => Gate::Pending { request },
		_ => gate_capability(capability, capabilities, registry),
	}
}

/// Evaluates the gate for an action kind as [`gate_kind`] does, narrowed by
/// the link to the host.
///
/// An action the link cannot carry now is unavailable for the reason
/// [`link_refusal`] states, whatever the host declared. The narrowing never
/// widens: a capability the host refused stays refused.
#[must_use]
pub fn gate_link(
	action: HostActionKind,
	connection: &ConnectionState,
	capabilities: &CapabilityMap,
	registry: &RequestRegistry,
) -> Gate {
	match link_refusal(action, connection) {
		Some(reason) => Gate::Unavailable { reason: reason.to_owned() },
		None => gate_kind(action, capabilities, registry),
	}
}

/// Why the link to the host cannot carry an action of `action` now, or
/// `None` while it can.
///
/// A link that was lost or failed (`Reconnecting`, `Fatal`, and `Connecting`
/// past its first attempt) carries only `Attach`, `Detach` and
/// `RetryConnection`, the requests that restore or leave it. The capability
/// map still holds what the host declared while it was reachable, and a
/// request sent meanwhile waits for a socket that may never come. A window
/// that is detached or on its first attempt queues what it sends until the
/// link starts, and a syncing one has a live socket.
#[must_use]
pub const fn link_refusal(
	action: HostActionKind,
	connection: &ConnectionState,
) -> Option<&'static str> {
	if matches!(
		action,
		HostActionKind::Attach | HostActionKind::Detach | HostActionKind::RetryConnection
	) {
		return None;
	}
	match connection {
		ConnectionState::Reconnecting { .. } => Some(LINK_RETRYING),
		ConnectionState::Connecting { attempt } if *attempt > 1 => Some(LINK_RETRYING),
		ConnectionState::Fatal { .. } => Some(LINK_FAILED),
		ConnectionState::Detached
		| ConnectionState::Connecting { .. }
		| ConnectionState::Syncing { .. }
		| ConnectionState::Connected { .. } => None,
	}
}

/// The reason [`link_refusal`] gives while the link to the host is retried.
pub const LINK_RETRYING: &str = "Reconnecting to the host";

/// The reason [`link_refusal`] gives once the link to the host failed.
pub const LINK_FAILED: &str = "Not connected to the host";

/// Evaluates availability for a whole surface (§5.13).
///
/// Applies to cards, panel tabs, drawer tabs, and settings pages.
/// Unavailable while the host refuses the capability, else pending while any
/// action of that capability is in flight, else its status.
///
/// This is the one gate for a capability no action maps to (`Questions`,
/// `Plans`): its surface still has the fourth state (§1.2).
#[must_use]
pub fn gate_capability(
	capability: Capability,
	capabilities: &CapabilityMap,
	registry: &RequestRegistry,
) -> Gate {
	let status = capabilities.get(capability);
	if let CapabilityStatus::Unavailable { reason } = status {
		return Gate::Unavailable { reason: reason.clone() };
	}
	if let Some(request) = registry.find_pending_for_capability(capability) {
		return Gate::Pending { request };
	}
	if *status == CapabilityStatus::Available {
		Gate::Enabled
	} else {
		Gate::Unknown
	}
}
