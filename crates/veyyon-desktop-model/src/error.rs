use serde::{Deserialize, Serialize};

use crate::{
	connection::{RequestId, SessionId},
	registry::RequestRegistry,
	surface::SurfaceId,
};

/// Classification of backend error origins across nineteen distinct protocol
/// domains.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, strum::EnumIter,
)]
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

impl ErrorScope {
	/// Complete slice of all nineteen error scopes for runtime test sweeps.
	pub const ALL: [Self; 19] = [
		Self::Connection,
		Self::Session,
		Self::Transcript,
		Self::Tool,
		Self::Interaction,
		Self::Plan,
		Self::File,
		Self::Change,
		Self::Terminal,
		Self::Provider,
		Self::Mcp,
		Self::Extension,
		Self::Agent,
		Self::Task,
		Self::Settings,
		Self::Diagnostic,
		Self::Usage,
		Self::Authentication,
		Self::Lifecycle,
	];

	/// Returns wire string identifier for this scope.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Connection => "Connection",
			Self::Session => "Session",
			Self::Transcript => "Transcript",
			Self::Tool => "Tool",
			Self::Interaction => "Interaction",
			Self::Plan => "Plan",
			Self::File => "File",
			Self::Change => "Change",
			Self::Terminal => "Terminal",
			Self::Provider => "Provider",
			Self::Mcp => "Mcp",
			Self::Extension => "Extension",
			Self::Agent => "Agent",
			Self::Task => "Task",
			Self::Settings => "Settings",
			Self::Diagnostic => "Diagnostic",
			Self::Usage => "Usage",
			Self::Authentication => "Authentication",
			Self::Lifecycle => "Lifecycle",
		}
	}
}

/// Structured error payload received from the host transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendError {
	pub scope:          ErrorScope,
	pub code:           Option<String>,
	pub message:        String,
	pub retryable:      bool,
	pub request:        Option<RequestId>,
	pub occurred_at_ms: u64,
}

/// Returns true if errors originating from the given scope are inherently
/// retryable by default.
#[must_use]
pub const fn is_scope_retryable(scope: ErrorScope) -> bool {
	match scope {
		ErrorScope::Connection
		| ErrorScope::Session
		| ErrorScope::Tool
		| ErrorScope::Interaction
		| ErrorScope::Plan
		| ErrorScope::File
		| ErrorScope::Change
		| ErrorScope::Terminal
		| ErrorScope::Provider
		| ErrorScope::Mcp
		| ErrorScope::Agent
		| ErrorScope::Task
		| ErrorScope::Settings
		| ErrorScope::Diagnostic
		| ErrorScope::Usage
		| ErrorScope::Authentication => true,
		ErrorScope::Transcript | ErrorScope::Extension | ErrorScope::Lifecycle => false,
	}
}

/// Resolves the fallback target surface for an error scope when no matching
/// in-flight request exists.
#[must_use]
pub fn fallback_surface(scope: ErrorScope, session_id: Option<&SessionId>) -> SurfaceId {
	match scope {
		ErrorScope::Connection => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Session => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Transcript => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Tool => {
			if let Some(session) = session_id {
				SurfaceId::QueueSessionRow(session.clone())
			} else {
				SurfaceId::GlobalTitlebarLine
			}
		},
		ErrorScope::Interaction => {
			if let Some(session) = session_id {
				SurfaceId::ComposerSendButton(session.clone())
			} else {
				SurfaceId::GlobalTitlebarLine
			}
		},
		ErrorScope::Plan => {
			if let Some(session) = session_id {
				SurfaceId::ComposerSendButton(session.clone())
			} else {
				SurfaceId::GlobalTitlebarLine
			}
		},
		ErrorScope::File => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Change => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Terminal => {
			if let Some(session) = session_id {
				SurfaceId::TerminalCreateButton(session.clone())
			} else {
				SurfaceId::GlobalTitlebarLine
			}
		},
		ErrorScope::Provider => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Mcp => SurfaceId::SettingsField("mcp".to_string()),
		ErrorScope::Extension => SurfaceId::SettingsField("extensions".to_string()),
		ErrorScope::Agent => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Task => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Settings => SurfaceId::SettingsField("general".to_string()),
		ErrorScope::Diagnostic => SurfaceId::DiagnosticRefreshButton,
		ErrorScope::Usage => {
			if let Some(session) = session_id {
				SurfaceId::RightPanelUsageTab(session.clone())
			} else {
				SurfaceId::GlobalTitlebarLine
			}
		},
		ErrorScope::Authentication => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Lifecycle => SurfaceId::GlobalTitlebarLine,
	}
}

/// Routes a backend error to the specific originating control, or to the
/// appropriate fallback surface.
#[must_use]
pub fn route_error(
	error: &BackendError,
	registry: &RequestRegistry,
	active_session: Option<&SessionId>,
) -> SurfaceId {
	if let Some(in_flight) = error.request.and_then(|id| registry.get(&id)) {
		return in_flight.surface.clone();
	}
	fallback_surface(error.scope, active_session)
}
