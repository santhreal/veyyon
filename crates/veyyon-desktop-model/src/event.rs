use serde::{Deserialize, Serialize};

use crate::{
	capabilities::{Capability, CapabilityStatus},
	connection::{ConnectionState, RequestId, SessionId, Versioned},
	domain::{
		AgentView, AuthFlowView, ChangesView, ContextBreakdownView, ExportView, FileContentView,
		FileTreeView, KeybindingView, McpServerView, McpToolResultView, ModelsView, ProcessLogsChunk,
		ProcessView, ProviderView, SearchResultsView, TerminalOutputChunk, TerminalView, ThemesView,
		UsageView,
	},
	error::BackendError,
	interaction::PendingDecisions,
	streaming::StreamingMessageState,
	transcript::TranscriptEntry,
};

/// Status summary for a session stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionStatus {
	Complete,
	Interrupted,
	Aborted,
	Error,
	Pending,
	Unknown,
}

/// Lightweight session metadata returned in session directory listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
	pub id:                  SessionId,
	pub workspace:           String,
	pub path:                String,
	pub cwd:                 String,
	pub title:               Option<String>,
	pub parent_path:         Option<String>,
	pub created_at_ms:       u64,
	pub modified_at_ms:      u64,
	pub message_count:       u32,
	pub size_bytes:          u64,
	pub first_message:       Option<String>,
	pub searchable_messages: Option<String>,
	pub status:              SessionStatus,
}

/// Error encountered when reading or parsing a session header file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionLoadError {
	pub path:   String,
	pub reason: String,
}

/// Detailed session header information for the active session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionHeaderView {
	pub id:             SessionId,
	pub schema_version: u32,
	pub title:          Option<String>,
	pub title_source:   Option<String>,
	pub parent:         Option<SessionId>,
	pub created_at_ms:  u64,
	pub cwd:            String,
}

/// Complete list of all 26 snapshot section names defined by the protocol.
pub const ALL_SECTION_NAMES: &[&str] = &[
	"Sessions",
	"ActiveSession",
	"Transcript",
	"Capabilities",
	"Interactions",
	"Settings",
	"Diagnostics",
	"Changes",
	"FileTree",
	"FileContent",
	"SearchResults",
	"Terminals",
	"TerminalOutput",
	"Processes",
	"ProcessLogs",
	"Models",
	"Providers",
	"AuthFlow",
	"Mcp",
	"McpToolResult",
	"Agents",
	"Usage",
	"ContextBreakdown",
	"Export",
	"Themes",
	"Keybindings",
];

/// Domain sections received during initial connection or snapshot
/// synchronization.
///
/// Each section is the whole of its domain as the host holds it at that
/// moment, so reducing one replaces rather than merges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
#[strum_discriminants(name(SnapshotSectionKind), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(
	doc = "Fieldless projection of `SnapshotSection`, so sweeps can verify all 26 section variants."
)]
pub enum SnapshotSection {
	/// Session index metadata and deserialization failures.
	Sessions(Versioned<Vec<SessionSummary>>, Vec<SessionLoadError>),
	/// Active session header view.
	ActiveSession(Versioned<SessionHeaderView>),
	/// Active session transcript entries.
	Transcript(Versioned<Vec<TranscriptEntry>>),
	/// Protocol capabilities and status flags.
	Capabilities(Vec<(Capability, CapabilityStatus)>),
	/// Every decision a session is waiting on. Sent whenever one is raised or
	/// answered, and empty once none remain.
	Interactions {
		/// Target session identifier.
		session: SessionId,
		/// Pending decisions.
		pending: PendingDecisions,
	},
	/// Raw configuration settings payload.
	Settings(serde_json::Value),
	/// Diagnostic sources payload.
	Diagnostics(serde_json::Value),
	/// Git changes view with unified diff.
	Changes(ChangesView),
	/// Directory hierarchy tree view.
	FileTree(FileTreeView),
	/// File text content view.
	FileContent(FileContentView),
	/// Text search results.
	SearchResults(SearchResultsView),
	/// List of managed terminal sessions.
	Terminals(Vec<TerminalView>),
	/// Chunk of terminal output data.
	TerminalOutput(TerminalOutputChunk),
	/// List of supervised processes.
	Processes(Vec<ProcessView>),
	/// Chunk of process log lines.
	ProcessLogs(ProcessLogsChunk),
	/// Model catalog and active model selection.
	Models(ModelsView),
	/// Configured AI providers.
	Providers(Vec<ProviderView>),
	/// Active OAuth authentication flow.
	AuthFlow(AuthFlowView),
	/// Model Context Protocol servers.
	Mcp(Vec<McpServerView>),
	/// MCP tool execution result.
	McpToolResult(McpToolResultView),
	/// Background subagents.
	Agents(Vec<AgentView>),
	/// Session resource and token usage totals.
	Usage(UsageView),
	/// Context window breakdown by category.
	ContextBreakdown(ContextBreakdownView),
	/// Transcript export snapshot.
	Export(ExportView),
	/// Color themes.
	Themes(ThemesView),
	/// Keyboard shortcuts.
	Keybindings(Vec<KeybindingView>),
}

impl SnapshotSection {
	/// Returns the variant name string.
	#[must_use]
	pub const fn name(&self) -> &'static str {
		match self {
			Self::Sessions(..) => "Sessions",
			Self::ActiveSession(..) => "ActiveSession",
			Self::Transcript(..) => "Transcript",
			Self::Capabilities(..) => "Capabilities",
			Self::Interactions { .. } => "Interactions",
			Self::Settings(..) => "Settings",
			Self::Diagnostics(..) => "Diagnostics",
			Self::Changes(..) => "Changes",
			Self::FileTree(..) => "FileTree",
			Self::FileContent(..) => "FileContent",
			Self::SearchResults(..) => "SearchResults",
			Self::Terminals(..) => "Terminals",
			Self::TerminalOutput(..) => "TerminalOutput",
			Self::Processes(..) => "Processes",
			Self::ProcessLogs(..) => "ProcessLogs",
			Self::Models(..) => "Models",
			Self::Providers(..) => "Providers",
			Self::AuthFlow(..) => "AuthFlow",
			Self::Mcp(..) => "Mcp",
			Self::McpToolResult(..) => "McpToolResult",
			Self::Agents(..) => "Agents",
			Self::Usage(..) => "Usage",
			Self::ContextBreakdown(..) => "ContextBreakdown",
			Self::Export(..) => "Export",
			Self::Themes(..) => "Themes",
			Self::Keybindings(..) => "Keybindings",
		}
	}
}

/// Complete enumeration of the eight protocol event variants dispatched by host
/// transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostEvent {
	ConnectionChanged(ConnectionState),
	Snapshot(SnapshotSection),
	TranscriptAppended { revision: u64, entries: Vec<TranscriptEntry> },
	TranscriptUpdated { revision: u64, entry: TranscriptEntry },
	StreamingChanged(Option<StreamingMessageState>),
	RequestSucceeded { request: RequestId },
	RequestFailed { request: RequestId, error: BackendError },
	FatalProtocolError { message: String },
}

impl HostEvent {
	/// Returns the discriminator tag name for test sweeps.
	#[must_use]
	pub const fn tag(&self) -> &'static str {
		match self {
			Self::ConnectionChanged(_) => "ConnectionChanged",
			Self::Snapshot(_) => "Snapshot",
			Self::TranscriptAppended { .. } => "TranscriptAppended",
			Self::TranscriptUpdated { .. } => "TranscriptUpdated",
			Self::StreamingChanged(_) => "StreamingChanged",
			Self::RequestSucceeded { .. } => "RequestSucceeded",
			Self::RequestFailed { .. } => "RequestFailed",
			Self::FatalProtocolError { .. } => "FatalProtocolError",
		}
	}
}
