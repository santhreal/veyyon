//! Connection, protocol health, and capability availability.

use super::RequestId;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ConnectionState {
	Detached,
	Connecting { attempt: u32 },
	Syncing { received: u64, expected: Option<u64> },
	Connected { endpoint: String, protocol: u32 },
	Reconnecting { attempt: u32, retry_at_ms: u64, message: String },
	Fatal { message: String },
}

impl ConnectionState {
	pub fn is_connected(&self) -> bool {
		matches!(self, Self::Connected { .. })
	}
}

#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub enum Capability {
	Sessions,
	SessionDeletion,
	SessionTreeNavigation,
	Transcript,
	TurnControl,
	BackgroundSubmission,
	Tools,
	Approvals,
	Questions,
	Plans,
	Files,
	Changes,
	PendingEdits,
	Terminals,
	ProcessSupervisor,
	Models,
	Providers,
	Authentication,
	Mcp,
	Extensions,
	Agents,
	AgentCommands,
	Tasks,
	Settings,
	Themes,
	Keybindings,
	Diagnostics,
	Usage,
	ContextBreakdown,
	Lifecycle,
}

impl Capability {
	/// Every capability a host reports on, written out because a Rust enum
	/// cannot be enumerated at run time. A capability added above and left out
	/// here fails to compile.
	pub const ALL: [Self; 30] = [
		Self::Sessions,
		Self::SessionDeletion,
		Self::SessionTreeNavigation,
		Self::Transcript,
		Self::TurnControl,
		Self::BackgroundSubmission,
		Self::Tools,
		Self::Approvals,
		Self::Questions,
		Self::Plans,
		Self::Files,
		Self::Changes,
		Self::PendingEdits,
		Self::Terminals,
		Self::ProcessSupervisor,
		Self::Models,
		Self::Providers,
		Self::Authentication,
		Self::Mcp,
		Self::Extensions,
		Self::Agents,
		Self::AgentCommands,
		Self::Tasks,
		Self::Settings,
		Self::Themes,
		Self::Keybindings,
		Self::Diagnostics,
		Self::Usage,
		Self::ContextBreakdown,
		Self::Lifecycle,
	];
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CapabilityStatus {
	UnknownUntilAttached,
	Available,
	Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ErrorScope {
	Connection,
	Session,
	Transcript,
	Tool,
	Interaction,
	Plan,
	File,
	Change,
	Terminal,
	Provider,
	Mcp,
	Extension,
	Agent,
	Task,
	Settings,
	Diagnostic,
	Usage,
	Authentication,
	Lifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BackendError {
	pub scope:          ErrorScope,
	pub code:           Option<String>,
	pub message:        String,
	pub retryable:      bool,
	pub request:        Option<RequestId>,
	pub occurred_at_ms: u64,
}
