export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
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

export interface FallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}

export type AssistantContent =
	| TextContent
	| ThinkingContent
	| RedactedThinkingContent
	| ToolCallContent
	| FallbackContent;

export type WireStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type { WireStopReason as StopReason };

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

export interface WireUserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	synthetic?: boolean;
	timestamp: number;
}

export interface WireDeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface WireAssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	provider: string;
	usage: WireUsage;
	stopReason: WireStopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface WireToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type WireOutputMeta = unknown;

export interface WireBashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	signal?: number;
	cancelled: boolean;
	truncated: boolean;
	meta?: WireOutputMeta;
	excludeFromContext?: boolean;
	timestamp: number;
}

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

export interface WireCustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

export interface WireHookMessage {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

export interface WireBranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface WireCompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	warning?: string;
	timestamp: number;
}

export interface WireFileMentionMessage {
	role: "fileMention";
	files: {
		path: string;
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

export type {
	WireAssistantMessage as AssistantMessage,
	WireDeveloperMessage as DeveloperMessage,
	WireToolResultMessage as ToolResultMessage,
	WireUserMessage as UserMessage,
};

export interface WireSessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

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
	model: string;
	role?: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
}

export type WireSessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

export type { WireSessionEntry as SessionEntry };

export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

export interface CollabPromptDetails {
	from?: string;
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: WireMessage }
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
			mode?: "continue" | "retry";
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; mode?: "continue" | "retry" }
	| { type: "thinking_level_changed"; thinkingLevel?: string };

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
	reasoning?: boolean;
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
	readOnly?: boolean;
}

export interface SessionState {
	isStreaming: boolean;
	queuedMessageCount: number;
	sessionName?: string;
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
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
	model?: string;
}

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
			writeToken?: string;
	  }
	| { t: "prompt"; text: string; images?: ImageContent[] }
	| { t: "ui-response"; reqId: number; value?: CollabUiResponseValue }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number };

export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

export type HostFrame =
	| {
			t: "welcome";
			proto: number;
			header: WireSessionHeader;
			state: SessionState;
			agents: AgentSnapshot[];
			entryCount: number;
			readOnly?: boolean;
	  }
	| { t: "snapshot-chunk"; entries: WireSessionEntry[]; final: boolean }
	| { t: "entry"; entry: WireSessionEntry }
	| { t: "event"; event: AgentEvent }
	| { t: "state"; state: SessionState }
	| { t: "bus"; channel: BusChannel; data: unknown }
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

export type WireFrame = GuestFrame | HostFrame;

export const COLLAB_PROTO = 3;

export const INTENT_FIELD = "i";

export const ENVELOPE_HEADER_LENGTH = 4;

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

export const ROOM_ID_BYTES = 16;

export const ROOM_KEY_BYTES = 32;

export const WRITE_TOKEN_BYTES = 16;

const AES_ALGORITHM = "AES-GCM";

export const SEAL_IV_BYTES = 12;

const SEAL_TEXT_ENCODER = new TextEncoder();
const SEAL_TEXT_DECODER = new TextDecoder();

export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(ROOM_KEY_BYTES);
	crypto.getRandomValues(key);
	return key;
}

export function generateWriteToken(): Uint8Array {
	const token = new Uint8Array(WRITE_TOKEN_BYTES);
	crypto.getRandomValues(token);
	return token;
}

export async function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== ROOM_KEY_BYTES) {
		throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
	}
	return crypto.subtle.importKey("raw", new Uint8Array(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

export async function sealFrame<Frame>(key: CryptoKey, frame: Frame): Promise<Uint8Array> {
	return sealBytes(key, SEAL_TEXT_ENCODER.encode(JSON.stringify(frame)));
}

export async function openFrame<Frame>(key: CryptoKey, data: Uint8Array): Promise<Frame> {
	return JSON.parse(SEAL_TEXT_DECODER.decode(await openBytes(key, data))) as Frame;
}

export async function sealBytes(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const iv = new Uint8Array(SEAL_IV_BYTES);
	crypto.getRandomValues(iv);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(SEAL_IV_BYTES + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, SEAL_IV_BYTES);
	return out;
}

async function openBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	if (data.byteLength <= SEAL_IV_BYTES) {
		throw new Error("Sealed frame too short");
	}
	const iv = new Uint8Array(data.subarray(0, SEAL_IV_BYTES));
	const ciphertext = new Uint8Array(data.subarray(SEAL_IV_BYTES));
	return new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
}

export const WELCOME_TIMEOUT_MS = 30_000;

export const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;

export const TRANSCRIPT_TIMEOUT_MS = 20_000;

export const DEFAULT_RELAY_URL = "wss://share.veyyon.dev";

export const DEFAULT_SHARE_URL = "https://share.veyyon.dev/s";

export interface ParsedCollabLink {
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	writeToken?: Uint8Array;
}

export {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	type RelayControlMessage,
	type RelayControlToGuest,
	type RelayControlToHost,
	relayFatalCloseReason,
} from "./relay";

export const RECOMMENDED_SUFFIX = " (Recommended)";

export function withRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label : label + RECOMMENDED_SUFFIX;
}

export function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

export const TODO_STATUS_IS_TERMINAL = {
	pending: false,
	in_progress: false,
	completed: true,
	abandoned: true,
} as const;

export type TodoStatus = keyof typeof TODO_STATUS_IS_TERMINAL;

export const TODO_STATUSES: readonly TodoStatus[] = Object.keys(TODO_STATUS_IS_TERMINAL) as TodoStatus[];

export function isTerminalTodoStatus(status: TodoStatus): boolean {
	return TODO_STATUS_IS_TERMINAL[status] === true;
}

export function asTodoStatus(value: unknown): TodoStatus {
	return typeof value === "string" && Object.hasOwn(TODO_STATUS_IS_TERMINAL, value)
		? (value as TodoStatus)
		: "pending";
}

export const TODO_DONE_SUMMARY = "Todo list done";

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
