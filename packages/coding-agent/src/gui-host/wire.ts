/**
 * TypeScript mirror of the Rust wire types the desktop client speaks,
 * `crates/veyyon-desktop-model/src/`:
 * - `action.rs`: HostRequest, HostAction
 * - `event.rs`: HostEvent, SnapshotSection, SessionSummary, SessionHeaderView, SessionStatus
 * - `domain.rs`: every panel-domain section (changes, files, terminals, processes, models,
 *   providers, mcp, agents, usage, context, export, themes, keybindings)
 * - `connection.rs`: ConnectionState, Versioned, RequestId
 * - `capabilities.rs`: Capability, CapabilityStatus
 * - `error.rs`: BackendError, ErrorScope
 * - `transcript.rs`: TranscriptEntry, MessageRole, ContentBlock, EntryMeta
 * - `streaming.rs`: StreamingMessageState
 * - `interaction.rs`: PendingDecisions
 *
 * The Rust enum is the authority. Serde's external tagging is the encoding: a
 * unit variant is its name as a string, a struct variant is `{ Name: {...} }`.
 * `crates/veyyon-desktop-model/tests/fixtures/snapshot-sections.json` holds one
 * instance of every section; both sides read it, so a shape that drifts fails
 * the Rust deserialization test and the TypeScript assignment in
 * `test/gui-host/every-snapshot-section-is-one-the-desktop-decodes.test.ts`.
 */

export const PROTOCOL_VERSION = 1;

export type RequestId = number;

export type ConnectionState =
	| "Detached"
	| { Connecting: { attempt: number } }
	| { Syncing: { received: number; expected: number | null } }
	| { Connected: { endpoint: string; protocol: number } }
	| { Reconnecting: { attempt: number; retry_at_ms: number; message: string } }
	| { Fatal: { message: string } };

export const ALL_CAPABILITIES = [
	"Sessions",
	"SessionDeletion",
	"SessionTreeNavigation",
	"Transcript",
	"TurnControl",
	"BackgroundSubmission",
	"Tools",
	"Approvals",
	"Questions",
	"Plans",
	"Files",
	"Changes",
	"PendingEdits",
	"Terminals",
	"ProcessSupervisor",
	"Models",
	"Providers",
	"Authentication",
	"Mcp",
	"Extensions",
	"Agents",
	"AgentCommands",
	"Tasks",
	"Settings",
	"Themes",
	"Keybindings",
	"Diagnostics",
	"Usage",
	"ContextBreakdown",
	"Lifecycle",
] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

export type CapabilityStatus = "UnknownUntilAttached" | "Available" | { Unavailable: { reason: string } };

export type ErrorScope =
	| "Connection"
	| "Session"
	| "Transcript"
	| "Tool"
	| "Interaction"
	| "Plan"
	| "File"
	| "Change"
	| "Terminal"
	| "Provider"
	| "Mcp"
	| "Extension"
	| "Agent"
	| "Task"
	| "Settings"
	| "Diagnostic"
	| "Usage"
	| "Authentication"
	| "Lifecycle";

export interface BackendError {
	scope: ErrorScope;
	code: string | null;
	message: string;
	retryable: boolean;
	request: RequestId | null;
	occurred_at_ms: number;
}

export type SessionStatus = "Complete" | "Interrupted" | "Aborted" | "Error" | "Pending" | "Unknown";

export interface SessionSummary {
	id: string;
	workspace: string;
	path: string;
	cwd: string;
	title: string | null;
	parent_path: string | null;
	created_at_ms: number;
	modified_at_ms: number;
	message_count: number;
	size_bytes: number;
	first_message: string | null;
	searchable_messages: string | null;
	status: SessionStatus;
}

export interface SessionLoadError {
	path: string;
	reason: string;
}

export interface SessionHeaderView {
	id: string;
	schema_version: number;
	title: string | null;
	title_source: string | null;
	parent: string | null;
	created_at_ms: number;
	cwd: string;
}

export type MessageRole =
	| "User"
	| "Developer"
	| "Assistant"
	| "ToolResult"
	| "BashExecution"
	| "PythonExecution"
	| "Custom"
	| "BranchSummary"
	| "CompactionSummary"
	| "FileMention"
	| "Lifecycle"
	| "Unknown";

export type ContentBlock =
	| { Text: { text: string } }
	| { Image: { media_type: string; data: number[]; alt: string | null } }
	| { Thinking: { text: string } }
	| { RedactedThinking: { marker: string } }
	| { ToolCall: { id: string; name: string; arguments: unknown } }
	| { ToolResult: { tool: string; content: unknown; is_error: boolean } }
	| { Execution: { language: string; command: string | null; output: string; exit_code: number | null } }
	| {
			FileMention: {
				path: string;
				has_content: boolean;
				lines: number | null;
				bytes: number | null;
				unavailable_reason: string | null;
				image: number[] | null;
			};
	  }
	| { Diff: { raw: string } }
	| { ModelChange: { provider: string; model: string } }
	| { ThinkingChange: { level: string } }
	| { Lifecycle: { phase: string; reason: string | null } }
	| { Summary: { kind: string; text: string } }
	| { Fallback: { producer: string; value: unknown } }
	| { Unknown: { tag: string; value: unknown } };

export interface UsageTotals {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	orchestration_tokens: number;
	premium_requests: number;
	cost_microusd: number | null;
}

export interface EntryMeta {
	provider: string | null;
	model: string | null;
	stop_reason: string | null;
	error: string | null;
	usage: UsageTotals | null;
}

export interface TranscriptEntry {
	id: string;
	parent: string | null;
	revision: number;
	timestamp_ms: number;
	role: MessageRole;
	content: ContentBlock[];
	meta: EntryMeta | null;
	raw_discriminator: string;
	raw: unknown;
}

export interface StreamingMessageState {
	entry: string;
	tool: string | null;
	accumulating: TranscriptEntry;
	revision: number;
}

export interface Versioned<T> {
	revision: number;
	value: T;
}

/**
 * Decisions a session is waiting on. Mirrors `PendingDecisions` in
 * `crates/veyyon-desktop-model/src/interaction.rs`; the section carries the
 * whole set, so the desktop replaces rather than merges.
 */
export interface ApprovalInteraction {
	id: string;
	tool_name: string;
	detail: string;
	requested_at_ms: number;
}

export interface QuestionInteraction {
	id: string;
	prompt: string;
	/** Empty for a free-text question, which is answered with `{ text }`. */
	options: string[];
	requested_at_ms: number;
}

export interface PlanInteraction {
	id: string;
	markdown_plan: string;
	requested_at_ms: number;
}

export interface PendingDecisions {
	approvals: ApprovalInteraction[];
	questions: QuestionInteraction[];
	plans: PlanInteraction[];
}

/**
 * The `response` of `RespondToInteraction`, by the kind of decision it answers.
 * An approval's `scope` defaults to `"once"`; `"session"` stands for the rest
 * of the session, the same grant the terminal's "for session" rows record.
 */
export type InteractionResponse =
	| { approved: boolean; scope?: "once" | "session" }
	| { option: number }
	| { text: string }
	| { accepted: boolean };

/**
 * Panel-domain sections. Each is the whole of its domain as the host holds it
 * at that moment, so the desktop replaces on receipt. `TerminalOutput` and
 * `ProcessLogs` are the two that accumulate: a terminal's bytes and a
 * process's log lines arrive as they are produced, and `reset` marks the
 * chunk that starts a fresh scrollback.
 */
export type ChangeScope = "WorkingTree" | "Staged";
export type ChangeStatus = "Added" | "Modified" | "Deleted" | "Renamed" | "Untracked" | "Conflicted";

export interface ChangedFile {
	path: string;
	previous_path: string | null;
	status: ChangeStatus;
	additions: number;
	deletions: number;
}

export interface ChangesView {
	revision: number;
	repository: string | null;
	scope: ChangeScope;
	files: ChangedFile[];
	/** Unified diff of every file in `files` for `scope`. */
	diff: string;
}

export type FileKind = "File" | "Directory" | "Symlink";

export interface FileNode {
	/** Workspace-relative, `/`-separated. */
	path: string;
	name: string;
	kind: FileKind;
	depth: number;
}

export interface FileTreeView {
	root: string;
	entries: FileNode[];
	truncated: boolean;
}

export interface FileContentView {
	path: string;
	content: string;
	size_bytes: number;
	truncated: boolean;
	binary: boolean;
}

export interface SearchResultsView {
	query: string;
	paths: string[];
	truncated: boolean;
}

export type TerminalStatus = "Running" | { Exited: { code: number } } | { Failed: { message: string } };

export interface TerminalView {
	id: string;
	cwd: string;
	shell: string;
	cols: number;
	rows: number;
	status: TerminalStatus;
}

export interface TerminalOutputChunk {
	terminal: string;
	seq: number;
	data: number[];
	reset: boolean;
}

export interface ProcessView {
	name: string;
	pid: number | null;
	status: string;
	application: string;
	args: string[];
	cwd: string;
	lifetime: string;
	started_at_ms: number;
	exit_code: number | null;
	terminated_by: string | null;
}

export interface ProcessLogsChunk {
	process: string;
	lines: string[];
	cursor: number;
	reset: boolean;
}

export interface ModelRef {
	provider: string;
	id: string;
}

export interface ModelView extends ModelRef {
	name: string;
	reasoning: boolean;
	context_window: number;
	max_output: number;
}

export interface ModelsView {
	models: ModelView[];
	current: ModelRef | null;
	thinking_level: string | null;
	thinking_levels: string[];
}

export interface ProviderView {
	id: string;
	name: string;
	authenticated: boolean;
	oauth: boolean;
	api_key: boolean;
}

export type AuthFlowState = "AwaitingBrowser" | "AwaitingSecret" | "Completed" | "Failed" | "Cancelled";

export interface AuthFlowView {
	provider: string;
	state: AuthFlowState;
	url: string | null;
	prompt: string | null;
	message: string | null;
}

export type McpServerStatus = "Connected" | "Connecting" | "Disconnected" | { Error: { message: string } };

export interface McpServerView {
	name: string;
	enabled: boolean;
	status: McpServerStatus;
	tools: string[];
}

export interface McpToolResultView {
	server: string;
	tool: string;
	is_error: boolean;
	output: string;
}

export interface AgentView {
	id: string;
	display_name: string;
	kind: string;
	status: string;
	parent: string | null;
	scope: string;
	session: string | null;
}

export interface ContextCategory {
	name: string;
	tokens: number;
}

export interface ContextBreakdownView {
	session: string;
	total_tokens: number;
	limit_tokens: number | null;
	categories: ContextCategory[];
}

export interface UsageView {
	session: string;
	totals: UsageTotals;
}

export interface ExportView {
	session: string;
	format: string;
	path: string | null;
	content: string | null;
}

export interface ThemeView {
	id: string;
	name: string;
	dark: boolean;
}

export interface ThemesView {
	themes: ThemeView[];
	current: string;
}

export interface KeybindingView {
	action: string;
	keys: string[];
	source: string;
}

export type SnapshotSection =
	| { Sessions: [Versioned<SessionSummary[]>, SessionLoadError[]] }
	| { ActiveSession: Versioned<SessionHeaderView> }
	| { Transcript: Versioned<TranscriptEntry[]> }
	| { Capabilities: [Capability, CapabilityStatus][] }
	| { Interactions: { session: string; pending: PendingDecisions } }
	| { Settings: unknown }
	| { Diagnostics: unknown }
	| { Changes: ChangesView }
	| { FileTree: FileTreeView }
	| { FileContent: FileContentView }
	| { SearchResults: SearchResultsView }
	| { Terminals: TerminalView[] }
	| { TerminalOutput: TerminalOutputChunk }
	| { Processes: ProcessView[] }
	| { ProcessLogs: ProcessLogsChunk }
	| { Models: ModelsView }
	| { Providers: ProviderView[] }
	| { AuthFlow: AuthFlowView }
	| { Mcp: McpServerView[] }
	| { McpToolResult: McpToolResultView }
	| { Agents: AgentView[] }
	| { Usage: UsageView }
	| { ContextBreakdown: ContextBreakdownView }
	| { Export: ExportView }
	| { Themes: ThemesView }
	| { Keybindings: KeybindingView[] };

export const ALL_SNAPSHOT_SECTIONS = [
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
] as const;

export type SnapshotSectionTag = (typeof ALL_SNAPSHOT_SECTIONS)[number];

/** The one tag a section carries; `keyof` a union member is its tag. */
export function getSnapshotSectionTag(section: SnapshotSection): SnapshotSectionTag {
	return Object.keys(section)[0] as SnapshotSectionTag;
}

export type HostEvent =
	| { ConnectionChanged: ConnectionState }
	| { Snapshot: SnapshotSection }
	| { TranscriptAppended: { revision: number; entries: TranscriptEntry[] } }
	| { TranscriptUpdated: { revision: number; entry: TranscriptEntry } }
	| { StreamingChanged: StreamingMessageState | null }
	| { RequestSucceeded: { request: RequestId } }
	| { RequestFailed: { request: RequestId; error: BackendError } }
	| { FatalProtocolError: { message: string } };

export interface AttachmentSubmission {
	id: string;
	name: string;
	media_type: string;
	data: number[];
}

export type HostAction =
	| "Detach"
	| "RetryConnection"
	| "Shutdown"
	| "ListSessions"
	| { Attach: { endpoint: string | null } }
	| { OpenSession: { session: string } }
	| { LoadTranscript: { session: string; before: string | null } }
	| { SubmitPrompt: { session: string; text: string; attachments: AttachmentSubmission[] } }
	| { AbortTurn: { session: string } }
	| string
	| Record<string, unknown>;

export const ALL_HOST_ACTIONS = [
	"Attach",
	"Detach",
	"RetryConnection",
	"Shutdown",
	"ListSessions",
	"LoadTranscript",
	"OpenSession",
	"CreateSession",
	"RenameSession",
	"DeleteSession",
	"BranchSession",
	"ExportSession",
	"CompactSession",
	"HandoffSession",
	"SubmitPrompt",
	"Steer",
	"FollowUp",
	"AbortTurn",
	"SetQueueMode",
	"CancelTool",
	"RespondToInteraction",
	"LoadFileTree",
	"ReadFile",
	"SearchFiles",
	"OpenExternal",
	"RefreshChanges",
	"SelectChangeScope",
	"CreateTerminal",
	"AttachTerminal",
	"WriteTerminal",
	"ResizeTerminal",
	"RestartTerminal",
	"ClearTerminal",
	"CloseTerminal",
	"RefreshProcesses",
	"ProcessLogs",
	"ProcessSend",
	"ProcessSignal",
	"ProcessStop",
	"ProcessRestart",
	"ProcessStart",
	"ProcessWait",
	"ProcessDescribe",
	"RefreshModels",
	"SelectModel",
	"SetThinkingLevel",
	"RefreshProviders",
	"StartProviderAuth",
	"RefreshAuth",
	"SubmitAuthSecret",
	"OpenAuthUrl",
	"CancelAuthFlow",
	"RetryAuthFlow",
	"RefreshMcp",
	"ConnectMcp",
	"DisconnectMcp",
	"SetMcpEnabled",
	"CallMcpTool",
	"ReviveAgent",
	"SpawnTask",
	"CancelTask",
	"LoadSettings",
	"SetSetting",
	"ResetSetting",
	"LoadThemes",
	"LoadKeybindings",
	"SetKeybinding",
	"RefreshDiagnostics",
	"RetryDiagnosticSource",
	"ClearOutput",
	"GetUsage",
	"GetContextBreakdown",
] as const;

export type HostActionTag = (typeof ALL_HOST_ACTIONS)[number];

export const ACTION_TO_CAPABILITY: Record<HostActionTag, Capability> = {
	Attach: "Lifecycle",
	Detach: "Lifecycle",
	RetryConnection: "Lifecycle",
	Shutdown: "Lifecycle",
	ListSessions: "Sessions",
	OpenSession: "Sessions",
	CreateSession: "Sessions",
	RenameSession: "Sessions",
	DeleteSession: "SessionDeletion",
	BranchSession: "SessionTreeNavigation",
	ExportSession: "Sessions",
	CompactSession: "Sessions",
	HandoffSession: "Sessions",
	LoadTranscript: "Transcript",
	SubmitPrompt: "TurnControl",
	Steer: "TurnControl",
	FollowUp: "TurnControl",
	AbortTurn: "TurnControl",
	SetQueueMode: "TurnControl",
	CancelTool: "Tools",
	RespondToInteraction: "Approvals",
	LoadFileTree: "Files",
	ReadFile: "Files",
	SearchFiles: "Files",
	OpenExternal: "Files",
	RefreshChanges: "Changes",
	SelectChangeScope: "Changes",
	CreateTerminal: "Terminals",
	AttachTerminal: "Terminals",
	WriteTerminal: "Terminals",
	ResizeTerminal: "Terminals",
	RestartTerminal: "Terminals",
	ClearTerminal: "Terminals",
	CloseTerminal: "Terminals",
	RefreshProcesses: "ProcessSupervisor",
	ProcessLogs: "ProcessSupervisor",
	ProcessSend: "ProcessSupervisor",
	ProcessSignal: "ProcessSupervisor",
	ProcessStop: "ProcessSupervisor",
	ProcessRestart: "ProcessSupervisor",
	ProcessStart: "ProcessSupervisor",
	ProcessWait: "ProcessSupervisor",
	ProcessDescribe: "ProcessSupervisor",
	RefreshModels: "Models",
	SelectModel: "Models",
	SetThinkingLevel: "Models",
	RefreshProviders: "Providers",
	StartProviderAuth: "Authentication",
	RefreshAuth: "Authentication",
	SubmitAuthSecret: "Authentication",
	OpenAuthUrl: "Authentication",
	CancelAuthFlow: "Authentication",
	RetryAuthFlow: "Authentication",
	RefreshMcp: "Mcp",
	ConnectMcp: "Mcp",
	DisconnectMcp: "Mcp",
	SetMcpEnabled: "Mcp",
	CallMcpTool: "Mcp",
	ReviveAgent: "Agents",
	SpawnTask: "Tasks",
	CancelTask: "Tasks",
	LoadSettings: "Settings",
	SetSetting: "Settings",
	ResetSetting: "Settings",
	LoadThemes: "Themes",
	LoadKeybindings: "Keybindings",
	SetKeybinding: "Keybindings",
	RefreshDiagnostics: "Diagnostics",
	RetryDiagnosticSource: "Diagnostics",
	ClearOutput: "Sessions",
	GetUsage: "Usage",
	GetContextBreakdown: "ContextBreakdown",
};

export interface HostRequest {
	id: RequestId;
	action: HostAction;
}

/**
 * Extract the action tag name from any HostAction format.
 */
export function getActionTag(action: HostAction): string {
	if (typeof action === "string") {
		return action;
	}
	if (action && typeof action === "object") {
		const keys = Object.keys(action);
		if (keys.length > 0) {
			return keys[0];
		}
	}
	return String(action);
}
