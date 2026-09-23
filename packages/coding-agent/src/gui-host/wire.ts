import type { ToolView } from "@veyyon/view";
import type { AgentDisplayState } from "../registry/live-roster";

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

export const GUI_HOST_PROTOCOL_VERSION = 1;

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
	"Goals",
	"Share",
	"Profiles",
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
	| "Lifecycle"
	| "Share";

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
	/**
	 * The mode the session runs in: `plan`, `plan_paused`, `goal`, `vibe`, `loop`, or
	 * `none` when the agent runs with everything it has. Read from the last
	 * mode change the session recorded, so it survives a restart.
	 */
	mode: string;
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
	| { Video: { media_type: string; bytes: number } }
	| { Thinking: { text: string } }
	| { RedactedThinking: { marker: string } }
	| { ToolCall: { id: string; name: string; arguments: unknown; presentation?: ToolPresentation } }
	| { ToolResult: { tool: string; content: unknown; is_error: boolean; presentation?: ToolPresentation } }
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
	| { ModeChange: { mode: string } }
	| { Lifecycle: { phase: string; reason: string | null } }
	| { Summary: { kind: string; text: string } }
	| { Fallback: { producer: string; value: unknown } }
	| { Unknown: { tag: string; value: unknown } };

export interface ToolPresentation {
	expanded: boolean;
	view: ToolView;
}

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
	/**
	 * Plain text, one line per row of the card's mono pane. The wrapper's card
	 * is markdown for the terminal; the desktop draws these lines verbatim, so
	 * the emphasis markers come off in `approvalDetail`.
	 */
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
 * of the session, the same grant the terminal's "for session" rows record. A
 * plan sent back for revision carries the refinement asked for in `feedback`,
 * which is empty when the answer came from the card's own row.
 */
export type InteractionResponse =
	| { approved: boolean; scope?: "once" | "session" }
	| { option: number }
	| { text: string }
	| { accepted: boolean; feedback?: string };

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
	/** Unified diff of every file in `files` for `scope`, cut on a boundary at the host's budget. */
	diff: string;
	/** True when `diff` is a prefix: the host cut it at its budget. */
	diff_truncated: boolean;
	/** Changed files this snapshot does not list, held back at the host's file budget. */
	files_withheld: number;
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

/**
 * One line of a file that matched a content search: `line` is 1-indexed and
 * `preview` is the matched line, already truncated to a drawable width.
 * Mirrors `ContentMatch` in `crates/veyyon-desktop-model/src/domain/files.rs`.
 */
export interface ContentMatch {
	path: string;
	line: number;
	preview: string;
}

/**
 * The lines a content search matched, in the order the search reported them.
 * Mirrors `ContentMatchesView` in the same module.
 */
export interface ContentMatchesView {
	query: string;
	matches: ContentMatch[];
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
	input?: ("text" | "image" | "video")[];
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

export interface AgentView {
	id: string;
	/**
	 * The short name a person reads and says: `Main`, `Kestrel`, `Advisor-2`.
	 * Assigned from spawn order by `registry/live-roster.ts`, so both hosts
	 * call the same agent the same thing.
	 */
	call_sign: string;
	/** The registry's own label, which for a spawned agent is the agent TYPE it was spawned from. */
	display_name: string;
	/** The registry's kind: `main`, `sub` or `advisor`. */
	kind: string;
	/**
	 * The state a surface names: `running`, `blocked`, `idle`, `waiting`,
	 * `parked` or `aborted`. Finer than the registry's own status, which cannot
	 * say that a running agent is stopped at an approval prompt or that a
	 * stopped one is waiting on a peer. `registry/live-roster.ts` derives it,
	 * and `AgentState` in `crates/veyyon-desktop-model/src/domain/agents.rs`
	 * reads it.
	 */
	status: AgentDisplayState;
	parent: string | null;
	scope: string;
	session: string | null;
	/** Short gist of what the agent is doing right now; null when it has not said. */
	activity: string | null;
	/** The model it runs on as `provider/id`; null when the registry does not know. */
	model: string | null;
}

/** How one line of agent traffic landed. */
export type AgentMessageOutcome = "injected" | "woken" | "revived" | "failed";
export const AGENT_MESSAGE_OUTCOMES = ["injected", "woken", "revived", "failed"] as const;

/** One line of agent-to-agent traffic, oldest first, as the comms stream draws it. */
export interface AgentMessageView {
	id: string;
	from: string;
	to: string;
	body: string;
	at_ms: number;
	reply_to: string | null;
	outcome: AgentMessageOutcome;
	error: string | null;
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
	/** The theme configured for a dark ground. */
	dark: string;
	/** The theme configured for a light ground. */
	light: string;
}

export interface KeybindingView {
	action: string;
	keys: string[];
	source: string;
}

/** The type tag a setting is declared with; mirrors `SettingType` in the schema. */
export type SettingKindTag = "boolean" | "string" | "modelChain" | "number" | "enum" | "array" | "record";

export interface SettingOptionView {
	value: string;
	label: string;
	description: string | null;
}

/**
 * One setting as the desktop reads it: the effective value, its provenance,
 * the schema it is declared with and the copy the settings screen shows.
 * Mirrors `SettingEntry` in `crates/veyyon-desktop-model/src/domain/settings.rs`.
 */
export interface SettingEntryView {
	value: unknown;
	default: unknown;
	source: string;
	type: SettingKindTag;
	label: string | null;
	description: string | null;
	tab: string | null;
	group: string | null;
	values: string[];
	options: SettingOptionView[];
	min: number | null;
	max: number | null;
	global: boolean;
	advanced: boolean;
	hidden: boolean;
}

/**
 * The prompts a session holds behind a running turn, as the runtime holds
 * them: `steering` enters the turn in flight at its next boundary and
 * `follow_up` runs after it ends, both oldest first. `restored` carries the
 * text a `DequeueQueuedPrompt` took back out, on the one frame that answers
 * that action. Mirrors `QueuedPromptsView` in
 * `crates/veyyon-desktop-model/src/domain/queued.rs`.
 */
export interface QueuedPromptsView {
	session: string;
	steering: string[];
	follow_up: string[];
	restored: string | null;
}
/**
 * Where a command came from, so two rows with one name are told apart.
 * Mirrors `CommandSource` in `crates/veyyon-desktop-model/src/domain/commands.rs`.
 */
export type CommandSource = "Builtin" | "Skill" | "Extension" | "Custom" | "McpPrompt" | "File";

export interface CommandSubcommandView {
	name: string;
	description: string | null;
	usage: string | null;
}

/**
 * One slash command the host will run when it is sent back as a `RunCommand`.
 * Mirrors `CommandView` in `crates/veyyon-desktop-model/src/domain/commands.rs`.
 */
export interface CommandView {
	name: string;
	aliases: string[];
	description: string | null;
	input_hint: string | null;
	source: CommandSource;
	subcommands: CommandSubcommandView[];
}

/** Whether the host has frozen every agent it runs, and since when. */
export interface AgentPauseView {
	paused: boolean;
	since_ms: number | null;
}

/**
 * Every status a goal reports, as a value rather than a type alone, so a sweep reads the list
 * instead of restating it and a status added here turns an incomplete suite red.
 */
export const ALL_GOAL_STATUSES = ["active", "paused", "budget_limited", "complete", "dropped"] as const;

export type GoalStatus = (typeof ALL_GOAL_STATUSES)[number];

export interface GoalView {
	objective: string;
	status: GoalStatus;
	driving: boolean;
	tokens_used: number;
	token_budget: number | null;
	turns_completed: number;
	time_used_seconds: number;
	created_at_ms: number;
	updated_at_ms: number;
	stood_down: string | null;
}

export const ALL_GOAL_CONTROLS = ["pause", "resume", "drop"] as const;

export type GoalControl = (typeof ALL_GOAL_CONTROLS)[number];

/** Where the share is: what the window draws and what a control may ask for. */
export type SharePhase = "off" | "starting" | "hosting" | "stopping" | "joining" | "joined" | "leaving";
export const SHARE_PHASES = ["off", "starting", "hosting", "stopping", "joining", "joined", "leaving"] as const;

/** Which side of a share this window is on. */
export type ShareRole = "Off" | "Hosting" | "Guest";
export const SHARE_ROLES = ["Off", "Hosting", "Guest"] as const;

/** One party on the relay, the hosting session included. */
export interface ShareParticipantView {
	/** Relay peer id. The hosting session is 0. */
	id: number;
	name: string;
	/** False for a guest that arrived by the read-only link. */
	can_write: boolean;
	/** True for the row that is this window's own session. */
	is_host: boolean;
}

/** The room this window joined, present only while it is in one. */
export interface ShareGuestView {
	/** The relay room the link named. */
	room: string;
	/** What the hosting session calls itself, or null before the first state. */
	host_name: string | null;
	/** True when the link that was joined carries no write token. */
	read_only: boolean;
	/** False while the socket is down and the guest is reconnecting. */
	connected: boolean;
}

export interface ShareView {
	state: SharePhase;
	/** Whether this window hosts a share, is in one, or is in neither. */
	role: ShareRole;
	/** The relay the share runs on; null when the settings name none. */
	relay_url: string | null;
	/** The link another veyyon opens. Null unless hosting. */
	link: string | null;
	/** The same room in a browser. */
	web_link: string | null;
	/** The two links above, read-only. */
	view_link: string | null;
	web_view_link: string | null;
	participants: ShareParticipantView[];
	/** The room this window joined, or null when it joined none. */
	guest: ShareGuestView | null;
	/** Why the last attempt failed; null when nothing failed. */
	error: string | null;
}

/** One item a new profile copies from the profile it is seeded off. */
export interface ProfileCopyItemView {
	/** The key `createProfile` copies under; what a window sends back. */
	key: string;
	label: string;
	description: string;
}

/** One profile directory under the base config root. */
export interface ProfileView {
	/** Directory name. The default profile is the literal `default`. */
	name: string;
	/** What the profile shows as; the directory name when none was written. */
	display_name: string;
	root_dir: string;
	/** The endpoint a window attaches to for this profile, null when none fits. */
	endpoint: string | null;
	/** Why this profile has no addressable endpoint; null when it has one. */
	endpoint_error: string | null;
	/** True for the profile this host process runs under. */
	is_active: boolean;
}

export interface ProfilesView {
	/** Directory name of the profile this host runs under. */
	active: string;
	entries: ProfileView[];
	/** What a new profile may copy, in the order a window offers them. */
	copy_items: ProfileCopyItemView[];
}

export type SnapshotSection =
	| { Sessions: [Versioned<SessionSummary[]>, SessionLoadError[]] }
	| { ActiveSession: Versioned<SessionHeaderView> }
	| { Transcript: Versioned<TranscriptEntry[]> }
	| { SessionSearch: { query: string; sessions: SessionSummary[] } }
	| { SessionTranscript: { session: string; transcript: Versioned<TranscriptEntry[]> } }
	| { Capabilities: [Capability, CapabilityStatus][] }
	| { Interactions: { session: string; pending: PendingDecisions } }
	| { Settings: Record<string, SettingEntryView> }
	| { Diagnostics: unknown }
	| { Changes: ChangesView }
	| { FileTree: FileTreeView }
	| { FileContent: FileContentView }
	| { SearchResults: SearchResultsView }
	| { ContentMatches: ContentMatchesView }
	| { Terminals: TerminalView[] }
	| { TerminalOutput: TerminalOutputChunk }
	| { Processes: ProcessView[] }
	| { ProcessLogs: ProcessLogsChunk }
	| { Models: ModelsView }
	| { Providers: ProviderView[] }
	| { AuthFlow: AuthFlowView }
	| { Mcp: McpServerView[] }
	| { Agents: AgentView[] }
	| { AgentComms: AgentMessageView[] }
	| { Usage: UsageView }
	| { ContextBreakdown: ContextBreakdownView }
	| { Export: ExportView }
	| { Themes: ThemesView }
	| { Keybindings: KeybindingView[] }
	| { QueuedPrompts: QueuedPromptsView }
	| { Commands: CommandView[] }
	| { AgentPause: AgentPauseView }
	| { Goal: { session: string; goal: GoalView | null } }
	| { Share: ShareView }
	| { Profiles: ProfilesView };

export const ALL_SNAPSHOT_SECTIONS = [
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
	"Terminals",
	"TerminalOutput",
	"Processes",
	"ProcessLogs",
	"Models",
	"Providers",
	"AuthFlow",
	"Mcp",
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
	data: string;
}
export type SettableMode = "plan" | "vibe" | "loop" | "none";
export const SETTABLE_MODES = ["plan", "vibe", "loop", "none"] as const;

export type HostAction =
	| "Detach"
	| "RetryConnection"
	| "Shutdown"
	| "PauseAgents"
	| "ResumeAgents"
	| "RefreshAgents"
	| "ListSessions"
	| "ListCommands"
	| "StopShare"
	| "RefreshShare"
	| "LeaveShare"
	| "RefreshProfiles"
	| { StartShare: { read_only: boolean } }
	| { JoinShare: { session?: string; link: string } }
	| { Attach: { endpoint: string | null } }
	| { OpenSession: { session: string } }
	| { SearchSessions: { query: string } }
	| { PreviewSessionTranscript: { session: string } }
	| { LoadTranscript: { session: string; before: string | null } }
	| { SubmitPrompt: { session: string; text: string; attachments: AttachmentSubmission[] } }
	| { AbortTurn: { session: string } }
	| { RetryTurn: { session: string } }
	| { RephraseReply: { session: string } }
	| { ReviewPlan: { session: string } }
	| { SetToolViewExpanded: { session: string; call_id: string; expanded: boolean } }
	| { DequeueQueuedPrompt: { session: string } }
	| { RunCommand: { session: string; text: string } }
	| { SetGoal: { session: string; objective: string; token_budget: number | null } }
	| { ControlGoal: { session: string; op: GoalControl } }
	| { SetSessionMode: { session: string; mode: SettableMode } }
	| { CreateProfile: { name: string; copy: string[] } }
	| { RenameProfile: { name: string; display_name: string } }
	| { DeleteProfile: { name: string } }
	| string
	| Record<string, unknown>;

export const ALL_HOST_ACTIONS = [
	"Attach",
	"Detach",
	"RetryConnection",
	"Shutdown",
	"PauseAgents",
	"ResumeAgents",
	"ListSessions",
	"SearchSessions",
	"PreviewSessionTranscript",
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
	"RetryTurn",
	"RephraseReply",
	"ReviewPlan",
	"SetQueueMode",
	"SetSessionMode",
	"CancelTool",
	"SetToolViewExpanded",
	"DequeueQueuedPrompt",
	"RespondToInteraction",
	"LoadFileTree",
	"ReadFile",
	"SearchFiles",
	"SearchContent",
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
	"RefreshModels",
	"SelectModel",
	"SetThinkingLevel",
	"RefreshProviders",
	"StartProviderAuth",
	"SubmitAuthSecret",
	"OpenAuthUrl",
	"CancelAuthFlow",
	"RetryAuthFlow",
	"RefreshMcp",
	"SetMcpEnabled",
	"ReviveAgent",
	"RefreshAgents",
	"SpawnTask",
	"CancelTask",
	"ListCommands",
	"RunCommand",
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
	"SetGoal",
	"ControlGoal",
	"StartShare",
	"StopShare",
	"RefreshShare",
	"JoinShare",
	"LeaveShare",
	"RefreshProfiles",
	"CreateProfile",
	"RenameProfile",
	"DeleteProfile",
] as const;
export type HostActionTag = (typeof ALL_HOST_ACTIONS)[number];

export const ACTION_TO_CAPABILITY: Record<HostActionTag, Capability> = {
	Attach: "Lifecycle",
	Detach: "Lifecycle",
	RetryConnection: "Lifecycle",
	Shutdown: "Lifecycle",
	PauseAgents: "Lifecycle",
	ResumeAgents: "Lifecycle",
	ListSessions: "Sessions",
	SearchSessions: "Sessions",
	PreviewSessionTranscript: "Transcript",
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
	RetryTurn: "TurnControl",
	RephraseReply: "TurnControl",
	ReviewPlan: "Approvals",
	SetQueueMode: "TurnControl",
	SetSessionMode: "Sessions",
	CancelTool: "Tools",
	SetToolViewExpanded: "Tools",
	DequeueQueuedPrompt: "TurnControl",
	RespondToInteraction: "Approvals",
	LoadFileTree: "Files",
	ReadFile: "Files",
	SearchFiles: "Files",
	SearchContent: "Files",
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
	RefreshModels: "Models",
	SelectModel: "Models",
	SetThinkingLevel: "Models",
	RefreshProviders: "Providers",
	StartProviderAuth: "Authentication",
	SubmitAuthSecret: "Authentication",
	OpenAuthUrl: "Authentication",
	CancelAuthFlow: "Authentication",
	RetryAuthFlow: "Authentication",
	RefreshMcp: "Mcp",
	SetMcpEnabled: "Mcp",
	ReviveAgent: "Agents",
	RefreshAgents: "Agents",
	SpawnTask: "Tasks",
	CancelTask: "Tasks",
	ListCommands: "AgentCommands",
	RunCommand: "AgentCommands",
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
	SetGoal: "Goals",
	ControlGoal: "Goals",
	StartShare: "Share",
	StopShare: "Share",
	RefreshShare: "Share",
	JoinShare: "Share",
	LeaveShare: "Share",
	RefreshProfiles: "Profiles",
	CreateProfile: "Profiles",
	RenameProfile: "Profiles",
	DeleteProfile: "Profiles",
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

/**
 * Extract the section name a snapshot frame carries, for the message a
 * request states when its view could not be sent.
 */
export function snapshotSectionTag(section: SnapshotSection): string {
	return Object.keys(section)[0] ?? "unknown";
}
