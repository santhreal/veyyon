use serde::{Deserialize, Serialize};

pub use crate::action_kind::{HostActionKind, HostActionKind as Kind};
use crate::connection::{EntryId, RequestId, SessionId};

/// Binary attachment descriptor for prompt submission.
///
/// `media_type` is one of the image or video types the host accepts;
/// `data` crosses the wire as base64 (see [`crate::base64_bytes`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentSubmission {
	pub id:         String,
	pub name:       String,
	pub media_type: String,
	#[serde(with = "crate::base64_bytes")]
	pub data:       Vec<u8>,
}

/// Request wrapper carrying a unique identifier and action payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRequest {
	pub id:     RequestId,
	pub action: HostAction,
}

/// Enumeration of all 72 host actions across thirteen functional families.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostAction {
	// Connection family (4 actions)
	Attach {
		endpoint: Option<String>,
	},
	Detach,
	RetryConnection,
	Shutdown,

	// Sessions family (10 actions)
	ListSessions,
	OpenSession {
		session: SessionId,
	},
	CreateSession {
		workspace: Option<String>,
		title:     Option<String>,
	},
	RenameSession {
		session: SessionId,
		title:   String,
	},
	DeleteSession {
		session: SessionId,
	},
	BranchSession {
		session: SessionId,
		entry:   EntryId,
	},
	ExportSession {
		session: SessionId,
		format:  String,
	},
	CompactSession {
		session: SessionId,
	},
	HandoffSession {
		session: SessionId,
		target:  String,
	},
	LoadTranscript {
		session: SessionId,
		before:  Option<EntryId>,
	},

	// Turn control family (7 actions)
	SubmitPrompt {
		session:     SessionId,
		text:        String,
		attachments: Vec<AttachmentSubmission>,
	},
	Steer {
		session: SessionId,
		text:    String,
	},
	FollowUp {
		session: SessionId,
		text:    String,
	},
	AbortTurn {
		session: SessionId,
	},
	SetQueueMode {
		session: SessionId,
		mode:    String,
	},
	CancelTool {
		session:      SessionId,
		tool_call_id: String,
	},
	RespondToInteraction {
		session:        SessionId,
		interaction_id: String,
		response:       serde_json::Value,
	},

	// Files family (4 actions)
	LoadFileTree {
		root: Option<String>,
	},
	ReadFile {
		path: String,
	},
	SearchFiles {
		query: String,
	},
	OpenExternal {
		path: String,
	},

	// Changes family (2 actions)
	RefreshChanges,
	SelectChangeScope {
		scope: String,
	},

	// Terminals family (7 actions)
	CreateTerminal {
		cwd:   Option<String>,
		shell: Option<String>,
	},
	AttachTerminal {
		terminal_id: String,
	},
	WriteTerminal {
		terminal_id: String,
		data:        Vec<u8>,
	},
	ResizeTerminal {
		terminal_id: String,
		cols:        u16,
		rows:        u16,
	},
	RestartTerminal {
		terminal_id: String,
	},
	ClearTerminal {
		terminal_id: String,
	},
	CloseTerminal {
		terminal_id: String,
	},

	// Process supervisor family (9 actions)
	RefreshProcesses,
	ProcessLogs {
		process_id: String,
		follow:     bool,
	},
	ProcessSend {
		process_id: String,
		data:       Vec<u8>,
	},
	ProcessSignal {
		process_id: String,
		signal:     String,
	},
	ProcessStop {
		process_id: String,
	},
	ProcessRestart {
		process_id: String,
	},
	ProcessStart {
		command: String,
		args:    Vec<String>,
	},
	ProcessWait {
		process_id: String,
	},
	ProcessDescribe {
		process_id: String,
	},

	// Models family (3 actions)
	RefreshModels,
	SelectModel {
		provider: String,
		model:    String,
	},
	SetThinkingLevel {
		level: String,
	},

	// Auth and Providers family (7 actions)
	RefreshProviders,
	StartProviderAuth {
		provider: String,
	},
	RefreshAuth {
		provider: String,
	},
	SubmitAuthSecret {
		provider: String,
		secret:   String,
	},
	OpenAuthUrl {
		url: String,
	},
	CancelAuthFlow {
		provider: String,
	},
	RetryAuthFlow {
		provider: String,
	},

	// MCP family (5 actions)
	RefreshMcp,
	ConnectMcp {
		server: String,
	},
	DisconnectMcp {
		server: String,
	},
	SetMcpEnabled {
		server:  String,
		enabled: bool,
	},
	CallMcpTool {
		server:    String,
		tool:      String,
		arguments: serde_json::Value,
	},

	// Agents and Tasks family (3 actions)
	ReviveAgent {
		agent_id: String,
	},
	SpawnTask {
		task: String,
	},
	CancelTask {
		task_id: String,
	},

	// Settings family (6 actions)
	LoadSettings,
	SetSetting {
		key:   String,
		value: serde_json::Value,
	},
	ResetSetting {
		key: String,
	},
	LoadThemes,
	LoadKeybindings,
	SetKeybinding {
		binding: String,
		command: String,
	},

	// Diagnostics and Usage family (5 actions)
	RefreshDiagnostics,
	RetryDiagnosticSource {
		source: String,
	},
	ClearOutput {
		session: SessionId,
	},
	GetUsage {
		session: Option<SessionId>,
	},
	GetContextBreakdown {
		session: SessionId,
	},
}

impl HostAction {
	/// Resolves the discriminant kind for this action.
	#[must_use]
	pub const fn kind(&self) -> HostActionKind {
		match self {
			Self::Attach { .. } => HostActionKind::Attach,
			Self::Detach => HostActionKind::Detach,
			Self::RetryConnection => HostActionKind::RetryConnection,
			Self::Shutdown => HostActionKind::Shutdown,
			Self::ListSessions => HostActionKind::ListSessions,
			Self::OpenSession { .. } => HostActionKind::OpenSession,
			Self::CreateSession { .. } => HostActionKind::CreateSession,
			Self::RenameSession { .. } => HostActionKind::RenameSession,
			Self::DeleteSession { .. } => HostActionKind::DeleteSession,
			Self::BranchSession { .. } => HostActionKind::BranchSession,
			Self::ExportSession { .. } => HostActionKind::ExportSession,
			Self::CompactSession { .. } => HostActionKind::CompactSession,
			Self::HandoffSession { .. } => HostActionKind::HandoffSession,
			Self::LoadTranscript { .. } => HostActionKind::LoadTranscript,
			Self::SubmitPrompt { .. } => HostActionKind::SubmitPrompt,
			Self::Steer { .. } => HostActionKind::Steer,
			Self::FollowUp { .. } => HostActionKind::FollowUp,
			Self::AbortTurn { .. } => HostActionKind::AbortTurn,
			Self::SetQueueMode { .. } => HostActionKind::SetQueueMode,
			Self::CancelTool { .. } => HostActionKind::CancelTool,
			Self::RespondToInteraction { .. } => HostActionKind::RespondToInteraction,
			Self::LoadFileTree { .. } => HostActionKind::LoadFileTree,
			Self::ReadFile { .. } => HostActionKind::ReadFile,
			Self::SearchFiles { .. } => HostActionKind::SearchFiles,
			Self::OpenExternal { .. } => HostActionKind::OpenExternal,
			Self::RefreshChanges => HostActionKind::RefreshChanges,
			Self::SelectChangeScope { .. } => HostActionKind::SelectChangeScope,
			Self::CreateTerminal { .. } => HostActionKind::CreateTerminal,
			Self::AttachTerminal { .. } => HostActionKind::AttachTerminal,
			Self::WriteTerminal { .. } => HostActionKind::WriteTerminal,
			Self::ResizeTerminal { .. } => HostActionKind::ResizeTerminal,
			Self::RestartTerminal { .. } => HostActionKind::RestartTerminal,
			Self::ClearTerminal { .. } => HostActionKind::ClearTerminal,
			Self::CloseTerminal { .. } => HostActionKind::CloseTerminal,
			Self::RefreshProcesses => HostActionKind::RefreshProcesses,
			Self::ProcessLogs { .. } => HostActionKind::ProcessLogs,
			Self::ProcessSend { .. } => HostActionKind::ProcessSend,
			Self::ProcessSignal { .. } => HostActionKind::ProcessSignal,
			Self::ProcessStop { .. } => HostActionKind::ProcessStop,
			Self::ProcessRestart { .. } => HostActionKind::ProcessRestart,
			Self::ProcessStart { .. } => HostActionKind::ProcessStart,
			Self::ProcessWait { .. } => HostActionKind::ProcessWait,
			Self::ProcessDescribe { .. } => HostActionKind::ProcessDescribe,
			Self::RefreshModels => HostActionKind::RefreshModels,
			Self::SelectModel { .. } => HostActionKind::SelectModel,
			Self::SetThinkingLevel { .. } => HostActionKind::SetThinkingLevel,
			Self::RefreshProviders => HostActionKind::RefreshProviders,
			Self::StartProviderAuth { .. } => HostActionKind::StartProviderAuth,
			Self::RefreshAuth { .. } => HostActionKind::RefreshAuth,
			Self::SubmitAuthSecret { .. } => HostActionKind::SubmitAuthSecret,
			Self::OpenAuthUrl { .. } => HostActionKind::OpenAuthUrl,
			Self::CancelAuthFlow { .. } => HostActionKind::CancelAuthFlow,
			Self::RetryAuthFlow { .. } => HostActionKind::RetryAuthFlow,
			Self::RefreshMcp => HostActionKind::RefreshMcp,
			Self::ConnectMcp { .. } => HostActionKind::ConnectMcp,
			Self::DisconnectMcp { .. } => HostActionKind::DisconnectMcp,
			Self::SetMcpEnabled { .. } => HostActionKind::SetMcpEnabled,
			Self::CallMcpTool { .. } => HostActionKind::CallMcpTool,
			Self::ReviveAgent { .. } => HostActionKind::ReviveAgent,
			Self::SpawnTask { .. } => HostActionKind::SpawnTask,
			Self::CancelTask { .. } => HostActionKind::CancelTask,
			Self::LoadSettings => HostActionKind::LoadSettings,
			Self::SetSetting { .. } => HostActionKind::SetSetting,
			Self::ResetSetting { .. } => HostActionKind::ResetSetting,
			Self::LoadThemes => HostActionKind::LoadThemes,
			Self::LoadKeybindings => HostActionKind::LoadKeybindings,
			Self::SetKeybinding { .. } => HostActionKind::SetKeybinding,
			Self::RefreshDiagnostics => HostActionKind::RefreshDiagnostics,
			Self::RetryDiagnosticSource { .. } => HostActionKind::RetryDiagnosticSource,
			Self::ClearOutput { .. } => HostActionKind::ClearOutput,
			Self::GetUsage { .. } => HostActionKind::GetUsage,
			Self::GetContextBreakdown { .. } => HostActionKind::GetContextBreakdown,
		}
	}
}
