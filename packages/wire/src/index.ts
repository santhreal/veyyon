/** Wire-format protocol types for collaboration sessions. */

// Content blocks
// ═══════════════════════════════════════════════════════════════════════════

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	/** e.g. "image/png". */
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}

/** Anthropic server-side-fallback boundary marker, persisted on an assistant turn whose request opted */
export interface FallbackContent {
	type: "fallback";
	/** The model the turn started on. */
	from: { model: string };
	/** The model the provider fell back to. */
	to: { model: string };
}

export type AssistantContent =
	| TextContent
	| ThinkingContent
	| RedactedThinkingContent
	| ToolCallContent
	| FallbackContent;

/** Why a turn ended, as a guest receives it. */
export type WireStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** The old name for {@link WireStopReason}, kept because this package is published. */
export type { WireStopReason as StopReason };

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

// Messages
// ═══════════════════════════════════════════════════════════════════════════

/** A user turn, as a guest receives it. */
export interface WireUserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g. auto-continue). */
	synthetic?: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

/** Developer turn message as received by guest replica. */
export interface WireDeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

/** An assistant turn, as a guest receives it. */
export interface WireAssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	/** Which provider answered, as a bare id such as `"anthropic"`. */
	provider: string;
	usage: WireUsage;
	stopReason: WireStopReason;
	errorMessage?: string;
	timestamp: number;
}

/** Tool result message as received by guest replica. */
export interface WireToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

/** The output notice a guest draws under a command's output. */
export type WireOutputMeta = unknown;

/** Command execution message and output. */
export interface WireBashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	/** The signal that killed it, when it died from one. Absent means "not known", not "not a signal". */
	signal?: number;
	cancelled: boolean;
	truncated: boolean;
	meta?: WireOutputMeta;
	/** Drawn: a `!!` execution is marked in the transcript as excluded from the model's context. */
	excludeFromContext?: boolean;
	timestamp: number;
}

/** Eval cell execution message and output. */
export interface WirePythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: WireOutputMeta;
	excludeFromContext?: boolean;
	timestamp: number;
}

/** A message an extension injected. */
export interface WireCustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

/** The pre-extensions spelling of the above, kept because old sessions still contain them. */
export interface WireHookMessage {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

/** Summary message left when a branch is cut. */
export interface WireBranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

/** The summary compaction left in place of the turns it replaced. */
export interface WireCompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	/** A dead-end warning the progress guard attached; drawn beneath the summary. */
	warning?: string;
	timestamp: number;
}

/** Files pulled in by `@path`, drawn as a list of "Read <path>" rows. */
export interface WireFileMentionMessage {
	role: "fileMention";
	files: {
		path: string;
		/** Whether the host read a body for this file. The body itself is not sent. */
		hasContent: boolean;
		lineCount?: number;
		byteSize?: number;
		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}[];
	timestamp: number;
}

export type WireMessage =
	| WireUserMessage
	| WireDeveloperMessage
	| WireAssistantMessage
	| WireToolResultMessage
	| WireBashExecutionMessage
	| WirePythonExecutionMessage
	| WireCustomMessage
	| WireHookMessage
	| WireBranchSummaryMessage
	| WireCompactionSummaryMessage
	| WireFileMentionMessage;

/** The old names for the four message shapes above, kept because this package is published. */
export type {
	WireAssistantMessage as AssistantMessage,
	WireDeveloperMessage as DeveloperMessage,
	WireToolResultMessage as ToolResultMessage,
	WireUserMessage as UserMessage,
};

/** The session's first log line, as a guest receives it. */
export interface WireSessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

/** The old name for {@link WireSessionHeader}, kept because this package is published. */
export type { WireSessionHeader as SessionHeader };

export interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: WireMessage;
}

export interface CustomMessageEntry extends EntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format. */
	model: string;
	role?: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
}

/** Session entry variants rendered by guest. */
export type WireSessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

/** The old name for {@link WireSessionEntry}, kept because this package is published. */
export type { WireSessionEntry as SessionEntry };

/** customType of collab guest prompts injected on the host. */
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

/** `details` shape of `custom_message` entries with `customType === "collab-prompt"`. */
export interface CollabPromptDetails {
	from?: string;
}

// Events (handled subset)
// ═══════════════════════════════════════════════════════════════════════════

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: WireMessage }
	/** Carries the FULL accumulating partial message — no delta tracking needed. */
	| { type: "message_update"; message: WireMessage }
	| { type: "message_end"; message: WireMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "auto_compaction_start"; reason: string; action: string }
	| { type: "auto_compaction_end"; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			/** Which recovery is waiting. Absent means a retry; `continue` is a tool */
			mode?: "continue" | "retry";
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; mode?: "continue" | "retry" }
	| { type: "thinking_level_changed"; thinkingLevel?: string };

// State & agents
// ═══════════════════════════════════════════════════════════════════════════

/** The model a guest renders. */
export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
	/** Whether the model reasons at all. Gates the whole thinking display. */
	reasoning?: boolean;
	/** Which thinking efforts the model offers, and which one it starts on. */
	thinking?: {
		mode: string;
		efforts: readonly string[];
		defaultLevel?: string;
	};
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface Participant {
	name: string;
	role: "host" | "guest";
	/** True when the guest joined through a read-only (view) link. */
	readOnly?: boolean;
}

/** Debounced footer snapshot broadcast by the host. */
export interface SessionState {
	isStreaming: boolean;
	queuedMessageCount: number;
	sessionName?: string;
	/** Host cwd — display only; the guest never chdirs. */
	cwd: string;
	model?: WireModel;
	thinkingLevel?: string;
	contextUsage?: ContextUsage;
	participants: Participant[];
	isAborting?: boolean;
}

export interface AgentSnapshot {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	/** Whether the host has a transcript file for this agent (gates remote transcript fetch). */
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
	/** Model the agent runs on, as a `provider/id` string. Display-only; omitted when the host does not know it. */
	model?: string;
}

// Bus payloads (task subagent lifecycle/progress channels)
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: { tool: string; args: string; endMs: number }[];
	recentOutput: string[];
	toolCount: number;
	requests: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	resolvedModel?: string;
}

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
}

// Frames (JSON inside the AES-GCM seal)
// ═══════════════════════════════════════════════════════════════════════════

export type CollabUiSelectItem = string | { label: string; description?: string };

export type CollabUiResponseValue = string | undefined;

export type CollabUiRequestDraft =
	| {
			kind: "select";
			title: string;
			options: CollabUiSelectItem[];
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			helpText?: string;
	  }
	| {
			kind: "editor";
			title: string;
			prefill?: string;
	  };

export type CollabUiRequest = CollabUiRequestDraft & { reqId: number };

export type GuestFrame =
	| {
			t: "hello";
			proto: number;
			name: string;
			/** base64url write token proving full-link possession; absent for */
			writeToken?: string;
	  }
	| { t: "prompt"; text: string; images?: ImageContent[] }
	| { t: "ui-response"; reqId: number; value?: CollabUiResponseValue }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number };

/** EventBus channels mirrored to guests. */
export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

export type HostFrame =
	| {
			t: "welcome";
			proto: number;
			header: WireSessionHeader;
			state: SessionState;
			agents: AgentSnapshot[];
			/** Total number of `WireSessionEntry` items the host will deliver in the */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
	  }
	/** Targeted snapshot fragment delivered after `welcome`. Hosts split the */
	| { t: "snapshot-chunk"; entries: WireSessionEntry[]; final: boolean }
	| { t: "entry"; entry: WireSessionEntry }
	| { t: "event"; event: AgentEvent }
	| { t: "state"; state: SessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `text` is decoded JSONL from `fromByte`, `newSize` the next offset base. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

export type WireFrame = GuestFrame | HostFrame;

/** Wire protocol version carried in `hello`; the host rejects mismatches. */
export const COLLAB_PROTO = 3;

/** Parameter key used for intent tracing (e.g. prompt explanation/reasoning) */
export const INTENT_FIELD = "i";

// Envelope & link constants
// ═══════════════════════════════════════════════════════════════════════════

/** Envelope prefix codec for peer frames. */
export const ENVELOPE_HEADER_LENGTH = 4;

/** Wrap a sealed payload in the plaintext envelope. */
export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

/** Split an envelope into its peer id and payload, or null when it is too short */
export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Rewrite the peer id in place, without copying the payload. */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

export const ROOM_ID_BYTES = 16;

/** Room cryptographic keys and tokens. */
export const ROOM_KEY_BYTES = 32;

/** Random write token appended to the room key in full links */
export const WRITE_TOKEN_BYTES = 16;

// Frame sealing (AES-256-GCM)
// ═══════════════════════════════════════════════════════════════════════════

/** The sealed-frame layout: a 12-byte random IV, then the AES-GCM ciphertext with its tag. */
const AES_ALGORITHM = "AES-GCM";

/** Bytes of random IV prefixed to every sealed frame. */
export const SEAL_IV_BYTES = 12;

const SEAL_TEXT_ENCODER = new TextEncoder();
const SEAL_TEXT_DECODER = new TextDecoder();

/** Generate fresh random room key. */
export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(ROOM_KEY_BYTES);
	crypto.getRandomValues(key);
	return key;
}

/** Generate fresh random write token. */
export function generateWriteToken(): Uint8Array {
	const token = new Uint8Array(WRITE_TOKEN_BYTES);
	crypto.getRandomValues(token);
	return token;
}

/** Import a raw room key for sealing and opening. */
export async function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== ROOM_KEY_BYTES) {
		throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
	}
	// A fresh copy: WebCrypto reads the whole backing buffer of a view, so a key that arrived as a
	// slice of a larger read would otherwise import its neighbouring bytes too.
	return crypto.subtle.importKey("raw", new Uint8Array(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

/** Seal a frame as JSON under the room key. */
export async function sealFrame<Frame>(key: CryptoKey, frame: Frame): Promise<Uint8Array> {
	return sealBytes(key, SEAL_TEXT_ENCODER.encode(JSON.stringify(frame)));
}

/** Inverse of {@link sealFrame}. Throws on authentication failure or malformed input. */
export async function openFrame<Frame>(key: CryptoKey, data: Uint8Array): Promise<Frame> {
	return JSON.parse(SEAL_TEXT_DECODER.decode(await openBytes(key, data))) as Frame;
}

/** The envelope itself: `[12B random IV][AES-256-GCM ciphertext with its tag]`. */
export async function sealBytes(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const iv = new Uint8Array(SEAL_IV_BYTES);
	crypto.getRandomValues(iv);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(SEAL_IV_BYTES + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, SEAL_IV_BYTES);
	return out;
}

/** Decrypt and verify sealed frame bytes. */
export async function openBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	if (data.byteLength <= SEAL_IV_BYTES) {
		throw new Error("Sealed frame too short");
	}
	// Both slices are copied rather than viewed. WebCrypto reads a view's whole backing buffer, and
	// neither of these spans its own: the ciphertext always sits behind the IV.
	const iv = new Uint8Array(data.subarray(0, SEAL_IV_BYTES));
	const ciphertext = new Uint8Array(data.subarray(SEAL_IV_BYTES));
	return new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
}

// Guest join & request budgets
// ═══════════════════════════════════════════════════════════════════════════

/** Every guest implementation waits on the same three host round trips, so the */

/** A host that never answers `hello` ends the join. */
export const WELCOME_TIMEOUT_MS = 30_000;

/** Every snapshot chunk must make progress; the timer resets on each arrival, */
export const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;

/** One `fetch-transcript` round trip. Generous relative to a normal response */
export const TRANSCRIPT_TIMEOUT_MS = 20_000;

/** Default public relay; bare `<roomId>.<key>` links resolve against it. */
export const DEFAULT_RELAY_URL = "wss://share.veyyon.dev";

/** Default share viewer/upload base; `/share` links resolve against */
export const DEFAULT_SHARE_URL = "https://share.veyyon.dev/s";

export interface ParsedCollabLink {
	/** wss://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	/** Write token from a full link; absent for read-only (view) links. */
	writeToken?: Uint8Array;
}

// Relay protocol (TEXT JSON control messages, fatal close codes, send bound)
// ═══════════════════════════════════════════════════════════════════════════

// Owned by `./relay`, which has no imports, so a relay client pays one module for the protocol instead of
// this whole barrel. Re-exported here so anything that already took the relay types from `@veyyon/wire` is
// unchanged.
export {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	type RelayControlMessage,
	type RelayControlToGuest,
	type RelayControlToHost,
	relayFatalCloseReason,
} from "./relay";

// Ask-dialog option labels
// ═══════════════════════════════════════════════════════════════════════════

/** Marker the ask dialog appends to the recommended option's label. */
export const RECOMMENDED_SUFFIX = " (Recommended)";

/** Append {@link RECOMMENDED_SUFFIX} unless `label` already carries it. */
export function withRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label : label + RECOMMENDED_SUFFIX;
}

/** Remove a trailing {@link RECOMMENDED_SUFFIX}, leaving any other label untouched. */
export function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

// Todo status vocabulary
// ═══════════════════════════════════════════════════════════════════════════

/** Every todo status, paired with the one question every surface asks of it: */
export const TODO_STATUS_IS_TERMINAL = {
	pending: false,
	in_progress: false,
	completed: true,
	abandoned: true,
} as const;

export type TodoStatus = keyof typeof TODO_STATUS_IS_TERMINAL;

/** Every status in {@link TODO_STATUS_IS_TERMINAL}, for enumeration at run time. */
export const TODO_STATUSES: readonly TodoStatus[] = Object.keys(TODO_STATUS_IS_TERMINAL) as TodoStatus[];

/** A status no further work is expected on. The complement is open work. */
export function isTerminalTodoStatus(status: TodoStatus): boolean {
	return TODO_STATUS_IS_TERMINAL[status] === true;
}

/** Narrow arbitrary JSON (a transcript, a wire frame) to a status; anything */
export function asTodoStatus(value: unknown): TodoStatus {
	return typeof value === "string" && Object.hasOwn(TODO_STATUS_IS_TERMINAL, value)
		? (value as TodoStatus)
		: "pending";
}

/** Render summary line for finished todo board. */
export const TODO_DONE_SUMMARY = "Todo list done";

/** The board holds work and all of it is closed. */
export function isTodoListDone(
	phases: readonly { readonly tasks?: readonly { readonly status: TodoStatus }[] }[],
): boolean {
	let seen = false;
	for (const phase of phases) {
		for (const task of phase.tasks ?? []) {
			if (!isTerminalTodoStatus(task.status)) return false;
			seen = true;
		}
	}
	return seen;
}
