use serde::{Deserialize, Serialize};

pub use crate::session_listing::{
	SessionHeaderView, SessionLoadError, SessionStatus, SessionSummary,
};
use crate::{
	capabilities::{Capability, CapabilityStatus},
	connection::{ConnectionState, RequestId, SessionId, Versioned},
	domain::{
		AgentMessageView, AgentView, AuthFlowView, ChangesView, CommandView, ContentMatchesView,
		ContextBreakdownView, ExportView, FileContentView, FileTreeView, KeybindingView,
		McpServerView, ModelsView, ProcessLogsChunk, ProcessView, PromptHistoryView, ProviderView,
		QueuedPromptsView, SearchResultsView, SettingsView, TerminalOutputChunk, TerminalView,
		ThemesView, UsageView,
	},
	error::BackendError,
	interaction::PendingDecisions,
	streaming::{StreamingAppend, StreamingMessageState},
	transcript::TranscriptEntry,
};

/// Every snapshot section name the protocol defines, in variant order.
pub const ALL_SECTION_NAMES: &[&str] = &[
	"Sessions",
	"ActiveSession",
	"Transcript",
	"SessionSearch",
	"SessionTranscript",
	"Capabilities",
	"Interactions",
	"Settings",
	"Diagnostics",
	"Changes",
	"FileTree",
	"FileContent",
	"SearchResults",
	"ContentMatches",
	"PromptHistory",
	"Terminals",
	"TerminalOutput",
	"Processes",
	"ProcessLogs",
	"Models",
	"Providers",
	"AuthFlow",
	"Mcp",
	"McpCatalog",
	"McpProbe",
	"McpRegistry",
	"Agents",
	"AgentComms",
	"Share",
	"Profiles",
	"Usage",
	"ContextBreakdown",
	"Export",
	"Themes",
	"Keybindings",
	"QueuedPrompts",
	"Commands",
	"AgentPause",
	"Goal",
	"Dictation",
	"ForegroundCommand",
	"AutoswarmConsole",
	"Todo",
	"Accounts",
	"Extensions",
	"Host",
	"Checkout",
	"Pace",
	"ServingAccount",
	"Quota",
	"ExtensionUi",
	"ComposerEdit",
	"ComposerCompletions",
	"ExtensionNotice",
	"SessionTree",
];

/// Domain sections received during initial connection or snapshot
/// synchronization.
///
/// Each section is the whole of its domain as the host holds it at that
/// moment, so reducing one replaces rather than merges.
#[derive(
	Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, strum::EnumDiscriminants,
)]
#[strum_discriminants(name(SnapshotSectionKind), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(
	doc = "Fieldless projection of `SnapshotSection`, so a sweep covers every section variant."
)]
pub enum SnapshotSection {
	/// Session index metadata and deserialization failures.
	Sessions(Versioned<Vec<SessionSummary>>, Vec<SessionLoadError>),
	/// Active session header view.
	ActiveSession(Versioned<SessionHeaderView>),
	/// Active session transcript entries.
	Transcript(Versioned<Vec<TranscriptEntry>>),
	/// Cross-repository persisted session search, independent of the live queue.
	SessionSearch(crate::domain::SessionSearchView),
	/// Read-only history transcript; never changes the active session.
	SessionTranscript(crate::domain::SessionTranscriptView),
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
	/// Every setting the host reports, with its schema and copy.
	Settings(SettingsView),
	/// Diagnostic sources payload.
	Diagnostics(#[ts(type = "unknown")] serde_json::Value),
	/// Git changes view with unified diff.
	Changes(ChangesView),
	/// Directory hierarchy tree view.
	FileTree(FileTreeView),
	/// File text content view.
	FileContent(FileContentView),
	/// Text search results.
	SearchResults(SearchResultsView),
	/// The lines a content search matched.
	ContentMatches(ContentMatchesView),
	/// The prompts a history lookup matched.
	PromptHistory(PromptHistoryView),
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
	/// The resources, prompts and notifications the connected MCP servers
	/// offer.
	McpCatalog(crate::domain::McpCatalogView),
	/// The outcome of a `TestMcpServer`.
	McpProbe(crate::domain::McpProbeView),
	/// The Smithery registry's sign-in state and last search results.
	McpRegistry(crate::domain::McpRegistryView),
	/// Background subagents.
	Agents(Vec<AgentView>),
	/// Agent-to-agent IRC comms message stream.
	AgentComms(Vec<AgentMessageView>),
	/// Relay session sharing status and link bundle.
	Share(crate::domain::ShareView),
	/// The profiles on disk, and where each one's host is.
	Profiles(crate::domain::ProfilesView),
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
	/// The prompts a session holds behind a running turn, and the one a
	/// `DequeueQueuedPrompt` handed back.
	QueuedPrompts(QueuedPromptsView),
	/// Every slash command the host will run, which the palette ranks.
	Commands(Vec<CommandView>),
	/// Whether every agent in the host process is frozen, and since when.
	AgentPause(crate::domain::AgentPauseView),
	/// Goal mode state for a session.
	Goal {
		/// Target session identifier.
		session: SessionId,
		/// Goal view or None if cleared.
		goal:    Option<crate::domain::GoalView>,
	},
	/// The speech this window is dictating.
	Dictation(crate::domain::DictationView),
	/// The command a session is waiting on in the foreground, or its absence
	/// once the wait settles.
	ForegroundCommand {
		/// Target session identifier.
		session: SessionId,
		/// The command being waited on, or None once nothing is.
		command: Option<crate::domain::ForegroundCommandView>,
	},
	/// The autoswarm console a session has open, or its absence once it
	/// closes.
	AutoswarmConsole {
		/// Target session identifier.
		session: SessionId,
		/// The console as the host holds it, or None once none is open.
		console: Option<crate::domain::AutoswarmConsoleView>,
	},
	/// The plan a session is working, or its absence once the board empties.
	Todo {
		/// Target session identifier.
		session: SessionId,
		/// The board as the host holds it, or None once it records no task.
		board:   Option<crate::domain::TodoBoardView>,
	},
	/// Every credential the host stores for a provider.
	Accounts(Vec<crate::domain::StoredAccountView>),
	/// The extensions, skills, hooks and other items the host discovers.
	Extensions(crate::domain::ExtensionsView),
	/// The machine the host runs on.
	Host(crate::domain::HostView),
	/// The branch a session's checkout is on, or its absence outside a
	/// repository.
	Checkout {
		/// Target session identifier.
		session:  SessionId,
		/// The checkout as the host reads it, or None outside a repository.
		checkout: Option<crate::domain::CheckoutView>,
	},
	/// How long the agent has worked in a session and how fast it replies.
	Pace {
		/// Target session identifier.
		session: SessionId,
		/// The session's pace as the host holds it.
		pace:    crate::domain::PaceView,
	},
	/// The stored login serving a session, or its absence when the session's
	/// provider stores none.
	ServingAccount {
		/// Target session identifier.
		session: SessionId,
		/// The serving login, or None when no login is stored.
		account: Option<crate::domain::ServingAccountView>,
	},
	/// The subscription quota of the login serving a session, or its absence
	/// when the provider reports none.
	Quota {
		/// Target session identifier.
		session: SessionId,
		/// The quota windows, or None when the provider reports none.
		quota:   Option<crate::domain::QuotaView>,
	},
	/// What a session's extensions draw around its composer.
	ExtensionUi { session: SessionId, ui: crate::domain::ExtensionUiView },
	/// An edit an extension made to a session's draft. Sent once per edit and
	/// never restated, so a reattaching window cannot apply one twice.
	ComposerEdit { session: SessionId, edit: crate::domain::ComposerEditView },
	/// The answer to a `CompleteComposer`.
	ComposerCompletions {
		session:     SessionId,
		completions: crate::domain::ComposerCompletionsView,
	},
	/// A notice an extension raised in a session.
	ExtensionNotice { session: SessionId, notice: crate::domain::ExtensionNoticeView },
	/// The answer to a `LoadSessionTree`, restated after a navigation or a
	/// label change moves what it shows.
	SessionTree { session: SessionId, tree: crate::domain::SessionTreeView },
}

impl SnapshotSection {
	/// Returns the variant name string.
	#[must_use]
	pub const fn name(&self) -> &'static str {
		match self {
			Self::Sessions(..) => "Sessions",
			Self::ActiveSession(..) => "ActiveSession",
			Self::Transcript(..) => "Transcript",
			Self::SessionSearch(..) => "SessionSearch",
			Self::SessionTranscript(..) => "SessionTranscript",
			Self::Capabilities(..) => "Capabilities",
			Self::Interactions { .. } => "Interactions",
			Self::Settings(..) => "Settings",
			Self::Diagnostics(..) => "Diagnostics",
			Self::Changes(..) => "Changes",
			Self::FileTree(..) => "FileTree",
			Self::FileContent(..) => "FileContent",
			Self::SearchResults(..) => "SearchResults",
			Self::ContentMatches(..) => "ContentMatches",
			Self::PromptHistory(..) => "PromptHistory",
			Self::Terminals(..) => "Terminals",
			Self::TerminalOutput(..) => "TerminalOutput",
			Self::Processes(..) => "Processes",
			Self::ProcessLogs(..) => "ProcessLogs",
			Self::Models(..) => "Models",
			Self::Providers(..) => "Providers",
			Self::AuthFlow(..) => "AuthFlow",
			Self::Mcp(..) => "Mcp",
			Self::McpCatalog(..) => "McpCatalog",
			Self::McpProbe(..) => "McpProbe",
			Self::McpRegistry(..) => "McpRegistry",
			Self::Agents(..) => "Agents",
			Self::AgentComms(..) => "AgentComms",
			Self::Share(..) => "Share",
			Self::Profiles(..) => "Profiles",
			Self::Usage(..) => "Usage",
			Self::ContextBreakdown(..) => "ContextBreakdown",
			Self::Export(..) => "Export",
			Self::Themes(..) => "Themes",
			Self::Keybindings(..) => "Keybindings",
			Self::QueuedPrompts(..) => "QueuedPrompts",
			Self::Commands(..) => "Commands",
			Self::AgentPause(..) => "AgentPause",
			Self::Goal { .. } => "Goal",
			Self::Dictation(..) => "Dictation",
			Self::ForegroundCommand { .. } => "ForegroundCommand",
			Self::AutoswarmConsole { .. } => "AutoswarmConsole",
			Self::Todo { .. } => "Todo",
			Self::Accounts(..) => "Accounts",
			Self::Extensions(..) => "Extensions",
			Self::Host(..) => "Host",
			Self::Checkout { .. } => "Checkout",
			Self::Pace { .. } => "Pace",
			Self::ServingAccount { .. } => "ServingAccount",
			Self::Quota { .. } => "Quota",
			Self::ExtensionUi { .. } => "ExtensionUi",
			Self::ComposerEdit { .. } => "ComposerEdit",
			Self::ComposerCompletions { .. } => "ComposerCompletions",
			Self::ExtensionNotice { .. } => "ExtensionNotice",
			Self::SessionTree { .. } => "SessionTree",
		}
	}

	/// Returns the section tag matching the wire protocol.
	#[must_use]
	pub const fn section_tag(&self) -> &'static str {
		self.name()
	}
}

/// Complete enumeration of the protocol event variants dispatched by host
/// transport.
#[derive(
	Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, strum::EnumDiscriminants,
)]
#[strum_discriminants(name(HostEventKind), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(
	doc = "Fieldless projection of `HostEvent`, so a sweep covers every event the host sends."
)]
pub enum HostEvent {
	ConnectionChanged(ConnectionState),
	Snapshot(SnapshotSection),
	TranscriptAppended {
		revision: u64,
		entries:  Vec<TranscriptEntry>,
	},
	TranscriptUpdated {
		revision: u64,
		entry:    TranscriptEntry,
	},
	StreamingChanged(Option<StreamingMessageState>),
	/// Text the streaming reply grew by; see [`StreamingAppend`].
	StreamingAppended(StreamingAppend),
	RequestSucceeded {
		request: RequestId,
	},
	RequestFailed {
		request: RequestId,
		error:   BackendError,
	},
	FatalProtocolError {
		message: String,
	},
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
			Self::StreamingAppended(_) => "StreamingAppended",
			Self::RequestSucceeded { .. } => "RequestSucceeded",
			Self::RequestFailed { .. } => "RequestFailed",
			Self::FatalProtocolError { .. } => "FatalProtocolError",
		}
	}
}
