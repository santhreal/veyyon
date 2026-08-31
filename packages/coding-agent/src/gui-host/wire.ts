/**
 * TypeScript mirror of the Rust host/model wire types for the GUI desktop client.
 *
 * All types are derived from the authoritative Rust definitions in `hosts/gui/core/src/`:
 * - `host.rs`: HostRequest, HostAction, HostEvent, SnapshotSection
 * - `model/connection.rs`: ConnectionState, Capability, CapabilityStatus, BackendError, ErrorScope
 * - `model/session.rs`: SessionSummary, SessionHeaderView, SessionStatus
 * - `model/transcript.rs`: TranscriptEntry, MessageRole, ContentBlock, EntryMeta, StreamingMessageState
 * - `model/remote.rs`: Versioned
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

export type SnapshotSection =
	| { Sessions: [Versioned<SessionSummary[]>, SessionLoadError[]] }
	| { ActiveSession: Versioned<SessionHeaderView> }
	| { Transcript: Versioned<TranscriptEntry[]> }
	| { Capabilities: [Capability, CapabilityStatus][] }
	| Record<string, unknown>;

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
	"SetTheme",
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
	SetTheme: "Themes",
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
