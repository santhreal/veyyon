//! The single typed host boundary.
//!
//! Every outbound action is wrapped in [`HostRequest`] with a nonzero
//! correlation id. Every inbound value reaches replicas through
//! `Store::apply`; transports never mutate the store directly.

use crate::model::*;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HostRequest {
	pub id:     RequestId,
	pub action: HostAction,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum HostAction {
	Attach {
		endpoint: Option<String>,
	},
	Detach,
	RetryConnection,
	Shutdown,
	ListSessions,
	LoadTranscript {
		session: SessionId,
		before:  Option<EntryId>,
	},
	OpenSession {
		session: SessionId,
	},
	CreateSession {
		workspace: Option<WorkspaceId>,
		parent:    Option<SessionId>,
	},
	RenameSession {
		session: SessionId,
		name:    String,
	},
	DeleteSession {
		session: SessionId,
	},
	BranchSession {
		session: SessionId,
		entry:   EntryId,
	},
	ExportSession {
		session:     SessionId,
		output_path: Option<String>,
	},
	CompactSession {
		session:      SessionId,
		instructions: Option<String>,
	},
	HandoffSession {
		session:      SessionId,
		instructions: Option<String>,
	},
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
		session:   SessionId,
		steering:  QueueDelivery,
		follow_up: QueueDelivery,
		interrupt: InterruptMode,
	},
	CancelTool {
		tool: ToolId,
	},
	RespondToInteraction {
		interaction: InteractionId,
		response:    InteractionResponse,
	},
	LoadFileTree {
		workspace: WorkspaceId,
		parent:    Option<FileId>,
	},
	ReadFile {
		file:  FileId,
		range: Option<LineRange>,
	},
	SearchFiles {
		workspace: WorkspaceId,
		query:     String,
		mode:      FileSearchMode,
	},
	OpenExternal {
		target: String,
	},
	RefreshChanges {
		scope: ChangeScope,
	},
	SelectChangeScope {
		scope: ChangeScope,
	},
	CreateTerminal {
		cwd: Option<String>,
	},
	AttachTerminal {
		terminal: TerminalId,
	},
	WriteTerminal {
		terminal: TerminalId,
		bytes:    Vec<u8>,
	},
	ResizeTerminal {
		terminal: TerminalId,
		cols:     u16,
		rows:     u16,
	},
	RestartTerminal {
		terminal: TerminalId,
	},
	ClearTerminal {
		terminal: TerminalId,
	},
	CloseTerminal {
		terminal: TerminalId,
	},
	RefreshProcesses,
	ProcessLogs {
		process:   ProcessId,
		from_byte: Option<u64>,
	},
	ProcessSend {
		process: ProcessId,
		text:    String,
	},
	ProcessSignal {
		process: ProcessId,
		signal:  String,
	},
	ProcessStop {
		process: ProcessId,
	},
	ProcessRestart {
		process: ProcessId,
	},
	ProcessStart {
		spec: Value,
	},
	ProcessWait {
		process: ProcessId,
	},
	ProcessDescribe {
		process: ProcessId,
	},
	RefreshModels,
	SelectModel {
		provider: ProviderId,
		model:    ModelId,
	},
	SetThinkingLevel {
		level: String,
	},
	RefreshProviders,
	StartProviderAuth {
		provider: ProviderId,
	},
	RefreshAuth,
	SubmitAuthSecret {
		provider: ProviderId,
		secret:   String,
	},
	OpenAuthUrl {
		provider: ProviderId,
		url:      String,
	},
	CancelAuthFlow {
		provider: ProviderId,
	},
	RetryAuthFlow {
		provider: ProviderId,
	},
	RefreshMcp,
	ConnectMcp {
		server: McpServerId,
	},
	DisconnectMcp {
		server: McpServerId,
	},
	SetMcpEnabled {
		server:  McpServerId,
		enabled: bool,
	},
	CallMcpTool {
		server:    McpServerId,
		tool:      String,
		arguments: Value,
	},
	ReadMcpResource {
		server: McpServerId,
		uri:    String,
	},
	GetMcpPrompt {
		server:    McpServerId,
		name:      String,
		arguments: Vec<(String, String)>,
	},
	RefreshExtensions,
	InvokeExtensionAction {
		extension: ExtensionId,
		action:    String,
		input:     Value,
	},
	SetExtensionEnabled {
		extension: ExtensionId,
		enabled:   bool,
	},
	SetToolEnabled {
		tool:    String,
		enabled: bool,
	},
	RefreshAgents,
	FetchAgentTranscript {
		agent:     AgentId,
		from_byte: u64,
	},
	ChatAgent {
		agent:   AgentId,
		message: String,
	},
	KillAgent {
		agent: AgentId,
	},
	ReviveAgent {
		agent: AgentId,
	},
	SpawnTask {
		agent:  AgentId,
		prompt: String,
	},
	CancelTask {
		task: TaskId,
	},
	LoadSettings,
	SetSetting {
		path:  SettingPath,
		value: Value,
	},
	ResetSetting {
		path: SettingPath,
	},
	LoadThemes,
	SetTheme {
		id: String,
	},
	LoadKeybindings,
	SetKeybinding {
		command: String,
		chord:   Option<String>,
	},
	RefreshDiagnostics,
	RetryDiagnosticSource {
		source: String,
	},
	ClearOutput,
	GetUsage,
	GetContextBreakdown,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SnapshotSection {
	Workspaces(Versioned<Vec<WorkspaceView>>),
	Sessions(Versioned<Vec<SessionSummary>>, Vec<SessionLoadError>),
	ActiveSession(Versioned<SessionHeaderView>),
	Transcript(Versioned<Vec<TranscriptEntry>>),
	TranscriptPaging(Versioned<TranscriptPagingState>),
	Runtime(Versioned<SessionRuntimeView>),
	Tools(Versioned<Vec<ToolCallView>>),
	Interactions(Versioned<Vec<InteractionRequest>>),
	Plan(Versioned<PlanState>),
	Files(Versioned<FileWorkspaceState>),
	Changes(Versioned<ChangesSnapshot>),
	Terminals(Versioned<Vec<TerminalRunView>>),
	Processes(Versioned<Vec<ProcessView>>, Vec<ProcessCompletion>),
	Output(Versioned<Vec<OutputRecord>>),
	Models(Versioned<ModelCatalogState>),
	Providers(Versioned<Vec<ProviderView>>),
	Authentication(Versioned<AuthState>),
	Mcp(Versioned<McpState>),
	Extensions(Versioned<ExtensionRegistryState>),
	Agents(Versioned<AgentRosterState>),
	Tasks(Versioned<Vec<TaskView>>),
	Settings(Versioned<SettingsState>),
	Themes(Versioned<ThemeState>),
	Keybindings(Versioned<KeybindingState>),
	Diagnostics(Versioned<DiagnosticsSnapshot>),
	Usage(Versioned<UsageSnapshot>),
	Context(Versioned<ContextSnapshot>),
	Lifecycle(Versioned<LifecycleState>),
	Capabilities(Vec<(Capability, CapabilityStatus)>),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum HostEvent {
	ConnectionChanged(ConnectionState),
	Snapshot(SnapshotSection),
	TranscriptAppended { revision: u64, entries: Vec<TranscriptEntry> },
	TranscriptUpdated { revision: u64, entry: TranscriptEntry },
	StreamingChanged(Option<StreamingMessageState>),
	ToolUpdated { revision: u64, tool: ToolCallView },
	InteractionPresented { revision: u64, request: InteractionRequest },
	InteractionEnded { revision: u64, interaction: InteractionId },
	TerminalOutput { revision: u64, terminal: TerminalId, bytes: Vec<u8> },
	OutputAdded { revision: u64, record: OutputRecord },
	NoticeAdded { revision: u64, notice: DiagnosticView },
	RequestSucceeded { request: RequestId },
	RequestFailed { request: RequestId, error: BackendError },
	FatalProtocolError { message: String },
}
