/**
 * Shared wire types for the veyyon collab live-session protocol.
 *
 * Dependency-free JSON shapes produced by `@veyyon/coding-agent`
 * (`src/collab/protocol.ts` and friends). Browser and test clients import this
 * package instead of depending on the coding-agent runtime; conformance is
 * asserted per variant in
 * `packages/coding-agent/test/collab/web-wire-conformance.test.ts`, which fails
 * the typecheck when a host-side entry stops being assignable to its wire shape.
 *
 * Unknown entry/event variants arrive over the wire as plain JSON. The unions
 * below cover only the variants this client renders; consumers cast at the
 * JSON boundary and every `switch` keeps a tolerant `default:` branch.
 */

// ═══════════════════════════════════════════════════════════════════════════
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

/**
 * Anthropic server-side-fallback boundary marker, persisted on an assistant turn whose request opted
 * into `AnthropicOptions.fallbacks`.
 *
 * It is here because it ARRIVES: the host serializes its assistant messages verbatim, and this block
 * is one of the five an assistant turn's content can hold. Leaving it out of the union did not stop it
 * reaching a guest, it only stopped the type from admitting so — and a client written against an
 * exhaustive `switch` had no reason to handle a block it was told could not exist.
 *
 * Renderers should ignore it. It marks where one model handed off to another and carries no content of
 * its own; the coding-agent's own converters strip it on any cross-provider hop for the same reason.
 */
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

/**
 * Why a turn ended, as a guest receives it.
 *
 * The same five literals `StopReason` in `@veyyon/ai` declares today, spelled separately because
 * this package has no runtime dependencies and a browser guest must not pull the host's model
 * layer in to render a transcript. Prefixed anyway: two identical-today unions under one name are
 * how they drift apart later without either side noticing.
 */
export type WireStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * The old name for {@link WireStopReason}, kept because this package is published.
 *
 * Deprecated: import `WireStopReason`. A renamed export rather than an alias declaration, so the
 * name keeps exactly one declaration repo-wide.
 */
export type { WireStopReason as StopReason };

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A user turn, as a guest receives it.
 *
 * The host's `UserMessage` in `@veyyon/ai` additionally carries `steering`, `attribution` and
 * `providerPayload`; none of the three is anything a guest draws.
 */
export interface WireUserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g. auto-continue). */
	synthetic?: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

/** A developer turn, as a guest receives it. Narrower than `DeveloperMessage` in `@veyyon/ai`. */
export interface WireDeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

/**
 * An assistant turn, as a guest receives it.
 *
 * The widest gap in this file. The host's `AssistantMessage` in `@veyyon/ai` carries the api it was
 * sent to, `providerPayload` (the transport-native history used to replay the turn upstream),
 * `request` (the exact sampling and reasoning parameters as sent), `contextSnapshot`,
 * `retryRecovery`, `responseId`, `turnMetrics`, `errorId` and more. A guest renders none of them.
 */
export interface WireAssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	/**
	 * Which provider answered, as a bare id such as `"anthropic"`.
	 *
	 * Declared rather than projected away because a guest holds a transcript replica, and a replica
	 * that cannot say what answered is not faithful. The host's `api` is NOT declared: that is the
	 * transport endpoint the request went to, which is a detail of how the host is configured.
	 */
	provider: string;
	usage: WireUsage;
	stopReason: WireStopReason;
	errorMessage?: string;
	timestamp: number;
}

/** A tool result, as a guest receives it. */
export interface WireToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

// ───────────────────────────────────────────────────────────────────────────
// The seven custom roles
//
// A session message can carry eleven roles. The four above are the model's own;
// these seven come from the host's `CustomAgentMessages` declaration-merging
// hook. A guest RENDERS them -- its replica transcript is drawn by the same
// renderer the host uses -- so they travel, and dropping them would make a `!ls`
// and its output vanish from every guest's transcript.
//
// They are declared here for the same reason the four above are: assignability
// runs the permissive way, so an undeclared field on a host shape reaches every
// guest and lands in their replica session file the day somebody adds it.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The output notice a guest draws under a command's output.
 *
 * Declared `unknown` on the same contract as a tool result's `details`, and for the same reason: the
 * notice is formatted by the host package's own formatter, which reads a truncation record, a source
 * record, a diagnostics record and a limits record, and narrowing it here would mean copying four
 * host types into a published contract and keeping them in step by hand. It is drawn in full, so
 * nothing is dropped; what is missing is a promise about width, and that is stated rather than
 * pretended.
 */
export type WireOutputMeta = unknown;

/** A `!command` the user ran, and what it printed. */
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

/** A `$code` the user ran in the Python kernel, and what it printed. */
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

/**
 * A message an extension injected.
 *
 * `details` is declared `unknown` deliberately, on the same contract as a tool result's `details`:
 * an extension owns the shape and the renderer it registered owns the drawing, so this package
 * cannot narrow it without breaking every extension. It is the one field here that is NOT a promise
 * about width, and an extension that puts a secret in it puts that secret on the wire.
 */
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

/** The summary left behind where a branch was cut. */
export interface WireBranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

/**
 * The summary compaction left in place of the turns it replaced.
 *
 * The host's own shape also carries `providerPayload`, the transport-native history used to replay
 * the compacted span upstream, plus two legacy block arrays from a removed image-archive engine.
 * None is drawn and the first is large, so none is declared.
 */
export interface WireCompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	/** A dead-end warning the progress guard attached; drawn beneath the summary. */
	warning?: string;
	timestamp: number;
}

/**
 * Files pulled in by `@path`, drawn as a list of "Read <path>" rows.
 *
 * The host's own shape carries each file's FULL TEXT in `content`, and the renderer draws none of it:
 * a row shows the path, the line count or the skip reason, and whether an image came with it. So
 * mentioning a 4 MB file sent 4 MB to every guest, on the join snapshot and again on the entry frame,
 * and it landed in their replica session file on disk. The body does not travel.
 *
 * `hasContent` is here because absence has to be distinguishable from emptiness. A guest that exports
 * its replica says the body was not replicated rather than printing an empty `<file>` block, which is
 * what dropping the field alone would have produced.
 */
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

/**
 * The old names for the four message shapes above, kept because this package is published.
 *
 * Deprecated: import the `Wire`-prefixed names. Renamed exports rather than alias declarations, so
 * each name keeps exactly one declaration repo-wide and `shared-types-have-one-owner.test.ts`
 * stays honest about it.
 */
export type {
	WireAssistantMessage as AssistantMessage,
	WireDeveloperMessage as DeveloperMessage,
	WireToolResultMessage as ToolResultMessage,
	WireUserMessage as UserMessage,
};

// ═══════════════════════════════════════════════════════════════════════════
// Session entries (rendered subset; cast `as WireSessionEntry` at the JSON
// boundary and skip unknown `type`s in a tolerant `default:`)
//
// This is the SUBSET a guest can render, not the session's own entry union.
// The host's is `SessionEntry` in `@veyyon/agent-core/compaction/entries`, and
// it carries a dozen more variants (mode changes, subagent spawns, settings
// snapshots) that no guest draws. Both were spelled `SessionEntry`, so
// `host.ts` had to import one of them under an alias to say which it meant,
// and an editor's auto-import decided the question everywhere else.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The session's first log line, as a guest receives it.
 *
 * The four fields a guest needs and nothing else. The host's own header (`SessionHeader` in
 * `@veyyon/coding-agent/session/session-entries`) additionally carries `titleSource`,
 * `parentSession`, `providerPromptCacheKey` and a schema `version`, and the stats parser's
 * (`SessionLogHeader` in `@veyyon/stats`) carries `version` too. All three were spelled
 * `SessionHeader`. The host now projects its header onto this shape before sending, so the
 * narrower type is what actually travels rather than merely what the guest promises to read.
 */
export interface WireSessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

/**
 * The old name for {@link WireSessionHeader}, kept because this package is published.
 *
 * Deprecated: import `WireSessionHeader`. A renamed export rather than an alias declaration, so
 * the name keeps exactly one declaration repo-wide.
 */
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

/** The entry variants a guest can render. See the section note above for what it is not. */
export type WireSessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

/**
 * The old name for {@link WireSessionEntry}, kept because this package is published.
 *
 * Deprecated: import `WireSessionEntry`. Written as a renamed export rather than
 * `export type SessionEntry = WireSessionEntry` on purpose, so the name has exactly one
 * declaration repo-wide and `shared-types-have-one-owner.test.ts` stays honest about it.
 */
export type { WireSessionEntry as SessionEntry };

/** customType of collab guest prompts injected on the host. */
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

/** `details` shape of `custom_message` entries with `customType === "collab-prompt"`. */
export interface CollabPromptDetails {
	from?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
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
			/**
			 * Which recovery is waiting. Absent means a retry; `continue` is a tool
			 * batch the host cannot resend being carried forward instead, which a
			 * guest must not render as a retry. Spelled out rather than imported so
			 * this package keeps depending on nothing.
			 */
			mode?: "continue" | "retry";
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; mode?: "continue" | "retry" }
	| { type: "thinking_level_changed"; thinkingLevel?: string };

// ═══════════════════════════════════════════════════════════════════════════
// State & agents
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The model a guest renders.
 *
 * A guest never builds a provider request: it renders a replica of the host's session and forwards
 * prompts to the host, which does the calling. So everything on the host's catalog `Model` that
 * exists to SHAPE a request is absent here by design, and that is a structural rule rather than a
 * field-by-field judgement. `baseUrl` is the field that made this worth fixing: on a proxied,
 * self-hosted or gateway-routed configuration it is an internal endpoint, and the state frame
 * re-broadcasts every couple of seconds while streaming, to every guest including read-only viewers.
 * Also absent, for the same reason: `api`, `requestModelId`, `headers`, `maxTokens`, the per-million
 * `cost` table and the compatibility record.
 *
 * What remains is what a guest DRAWS. The thinking fields are here because the status line shows a
 * thinking level and the model picker offers the levels the model actually has, and both read the
 * model rather than a separate field.
 */
export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
	/** Whether the model reasons at all. Gates the whole thinking display. */
	reasoning?: boolean;
	/**
	 * Which thinking efforts the model offers, and which one it starts on.
	 *
	 * A narrowed copy of the host's `ThinkingConfig`. The parts left out (`effortMap`,
	 * `effortRouting`, per-effort token budgets, `supportsDisplay`) all encode an effort into a
	 * provider wire field, which is request shaping and never happens on a guest.
	 */
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

// ═══════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════
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
			/**
			 * base64url write token proving full-link possession; absent for
			 * read-only (view) links. The host marks peers without a valid token
			 * read-only and rejects their mutating frames.
			 */
			writeToken?: string;
	  }
	| { t: "prompt"; text: string; images?: ImageContent[] }
	| { t: "ui-response"; reqId: number; value?: CollabUiResponseValue }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number };

/** EventBus channels mirrored to guests (task subagent traffic only). */
export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

export type HostFrame =
	| {
			t: "welcome";
			proto: number;
			header: WireSessionHeader;
			state: SessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `WireSessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. Guests stay in the loading
			 * phase until they have accumulated all of them (or a chunk arrives
			 * with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Hosts split the
	 * transcript into chunks bounded by byte size so a multi-MB session is not
	 * forced through one giant frame the relay may stall on. The last chunk
	 * carries `final: true`; guests finalize the replica on that frame.
	 */
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

/**
 * Wire protocol version carried in `hello`; the host rejects mismatches.
 *
 * - `1` (legacy): `welcome` carried the full `entries` array inline.
 * - `2`: `welcome` carries only metadata (header/state/agents/entryCount);
 *   transcript entries follow in `snapshot-chunk` frames, so multi-MB
 *   sessions are not gated on a single welcome frame fitting under the
 *   guest's first-welcome timeout.
 * - `3`: host asks guests through `ui-request`/`ui-request-end` host frames
 *   answered by the `ui-response` guest frame. Guests that predate the
 *   grammar would silently drop `ui-request` (asks hang forever on the
 *   host), so they must be rejected at hello.
 */
export const COLLAB_PROTO = 3;

/** Parameter key used for intent tracing (e.g. prompt explanation/reasoning) */
export const INTENT_FIELD = "i";

// ═══════════════════════════════════════════════════════════════════════════
// Envelope & link constants
// ═══════════════════════════════════════════════════════════════════════════

/** Plaintext envelope prefix: `[4B uint32 BE peerId][sealed payload]`. */
export const ENVELOPE_HEADER_LENGTH = 4;

/**
 * Wrap a sealed payload in the plaintext envelope.
 *
 * Host→relay: peerId 0 broadcasts to all guests, peerId N targets guest N.
 * Guest→relay: always 0, and the relay rewrites it to the sender's id.
 *
 * The three envelope functions live here, with the constant they read, because
 * both ends of the link have to agree on them byte for byte: a host that wrote
 * the peer id little-endian and a guest that read it big-endian would exchange
 * frames that decrypt cleanly and address the wrong peer. They used to be
 * duplicated in `coding-agent/src/collab/protocol.ts` and
 * `collab-web/src/lib/link.ts`, which is the arrangement that allows that drift.
 * Nothing here touches Node, so the browser guest imports it directly.
 */
export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

/**
 * Split an envelope into its peer id and payload, or null when it is too short
 * to carry a header.
 *
 * The payload is a VIEW over the same buffer, not a copy: the sealed bytes go
 * straight to `crypto.subtle.decrypt`, and copying every frame would double the
 * per-frame allocation on a transcript stream.
 */
export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/**
 * Rewrite the peer id in place, without copying the payload.
 *
 * This is the relay's hot path: it stamps the sender's id onto a frame it is
 * about to forward, and the sealed payload is untouched because the relay has no
 * room key. `byteOffset` is passed explicitly so a frame that arrived as a view
 * into a larger read buffer is stamped at its own start, not the buffer's.
 */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

export const ROOM_ID_BYTES = 16;

/** AES-256-GCM room key; the seal key for every collab frame. */
export const ROOM_KEY_BYTES = 32;

/**
 * Random write token appended to the room key in full links
 * (`base64url(key ∥ token)`); view links carry the bare key. Possession
 * proves prompt/abort/agent-cmd capability to the host.
 */
export const WRITE_TOKEN_BYTES = 16;

// ═══════════════════════════════════════════════════════════════════════════
// Frame sealing (AES-256-GCM)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The sealed-frame layout: a 12-byte random IV, then the AES-GCM ciphertext with its tag.
 *
 * The host seals what the browser guest opens, so this is a wire format like the rest of this file
 * and not an implementation detail of either side. Both sides used to carry their own copy of the
 * whole thing, IV length and byte order included. That is the failure the envelope codec above had
 * as well, and it is worse here: change the IV length on one side and every frame fails to
 * authenticate, with the plaintext never recovered and nothing to say why, because a GCM tag
 * mismatch cannot distinguish a wrong key from a wrong layout.
 *
 * Nothing here reaches for Node, only WebCrypto, which is what lets the browser guest import it.
 */
const AES_ALGORITHM = "AES-GCM";

/** Bytes of random IV prefixed to every sealed frame. */
export const SEAL_IV_BYTES = 12;

const SEAL_TEXT_ENCODER = new TextEncoder();
const SEAL_TEXT_DECODER = new TextDecoder();

/** A fresh random room key. The key never leaves the link fragment; the relay sees only ciphertext. */
export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(ROOM_KEY_BYTES);
	crypto.getRandomValues(key);
	return key;
}

/** A fresh random write token, which is what proves prompt/abort capability to the host. */
export function generateWriteToken(): Uint8Array {
	const token = new Uint8Array(WRITE_TOKEN_BYTES);
	crypto.getRandomValues(token);
	return token;
}

/**
 * Import a raw room key for sealing and opening.
 *
 * The length check is not a formality: WebCrypto accepts 16, 24 and 32 byte AES keys, so a
 * truncated key from a mangled link would import cleanly as AES-128 and then fail to open every
 * frame, which looks like a relay fault rather than a bad link.
 *
 * `async` so the length failure arrives as a rejection, the same way a WebCrypto failure does. The
 * previous shape returned a promise but threw the length error synchronously, and one caller passes
 * the promise on without awaiting it (`new CollabSocket({ key: importRoomKey(...) })`), so a
 * mangled link threw out of the socket's construction where nothing was positioned to catch it.
 */
export async function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== ROOM_KEY_BYTES) {
		throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
	}
	// A fresh copy: WebCrypto reads the whole backing buffer of a view, so a key that arrived as a
	// slice of a larger read would otherwise import its neighbouring bytes too.
	return crypto.subtle.importKey("raw", new Uint8Array(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

/**
 * Seal a frame as JSON under the room key.
 *
 * Generic over the frame type because the two sides name it differently: the browser guest works in
 * the JSON skeleton this file pins (`WireFrame`), while the host's frames carry richer session
 * types that serialize into those same shapes. The bytes are identical either way, which is the
 * only thing that has to agree.
 */
export async function sealFrame<Frame>(key: CryptoKey, frame: Frame): Promise<Uint8Array> {
	return sealBytes(key, SEAL_TEXT_ENCODER.encode(JSON.stringify(frame)));
}

/**
 * Inverse of {@link sealFrame}. Throws on authentication failure or malformed input.
 *
 * The caller names the frame type it expects; this does not validate it. The seal proves the frame
 * came from someone holding the room key, and the frame grammar is checked where it is handled.
 */
export async function openFrame<Frame>(key: CryptoKey, data: Uint8Array): Promise<Frame> {
	return JSON.parse(SEAL_TEXT_DECODER.decode(await openBytes(key, data))) as Frame;
}

/**
 * The envelope itself: `[12B random IV][AES-256-GCM ciphertext with its tag]`.
 *
 * Separate from {@link sealFrame} because not every payload is JSON. A shared session is gzipped
 * before it is sealed, and it was writing this same envelope a second time, with its own copy of
 * the IV length. Two hand-written copies of one wire format is how the two halves drift into
 * ciphertext that the other side reads as garbage, so the envelope has one writer and JSON is a
 * layer on top of it rather than a peer of it.
 */
export async function sealBytes(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const iv = new Uint8Array(SEAL_IV_BYTES);
	crypto.getRandomValues(iv);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(SEAL_IV_BYTES + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, SEAL_IV_BYTES);
	return out;
}

/** Inverse of {@link sealBytes}. Throws on authentication failure or malformed input. */
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

// ═══════════════════════════════════════════════════════════════════════════
// Guest join & request budgets
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Every guest implementation waits on the same three host round trips, so the
 * budgets belong to the protocol rather than to either client. There are two
 * guests today, the TUI's `collab/guest.ts` and the web client, and they had
 * each declared their own copies. Two of the three were kept in step by hand
 * (the web client's comments literally read "Mirrors the TUI guest's ..."),
 * and the third had already drifted: transcript fetches gave up after 10 s in
 * the browser and 20 s in the terminal, so the same host on the same relay
 * looked responsive to one guest and dead to the other. A comment is not a
 * mechanism, so the values live here now and both guests import them.
 */

/** A host that never answers `hello` ends the join. */
export const WELCOME_TIMEOUT_MS = 30_000;

/**
 * Every snapshot chunk must make progress; the timer resets on each arrival,
 * so a multi-MB snapshot fails only when the relay genuinely stalls rather
 * than because its total wall-clock crossed the welcome budget.
 */
export const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;

/**
 * One `fetch-transcript` round trip. Generous relative to a normal response
 * because the host may be reading a large transcript from disk, and short
 * enough that a wedged host does not leave a viewer waiting indefinitely.
 */
export const TRANSCRIPT_TIMEOUT_MS = 20_000;

/**
 * Default public relay; bare `<roomId>.<key>` links resolve against it.
 *
 * Points at the Veyyon-owned relay host. As of this writing `veyyon.dev` has
 * no live DNS/relay deployed yet — `/collab` against the default (no
 * `--relay` override) will fail to connect until that infra ships. Repoint
 * or override via `collab.relayUrl` once a real relay is standing.
 */
export const DEFAULT_RELAY_URL = "wss://share.veyyon.dev";

/**
 * Default share viewer/upload base; `/share` links resolve against
 * `<base>/<id>#<key>`.
 *
 * Same caveat as {@link DEFAULT_RELAY_URL}: `share.veyyon.dev` is not yet a
 * deployed Veyyon share server. `/share` without `--server`/`share.serverUrl`
 * will fail closed on upload (network error) rather than silently reaching
 * an unintended upstream server.
 */
export const DEFAULT_SHARE_URL = "https://share.veyyon.dev/s";

export interface ParsedCollabLink {
	/** wss://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	/** Write token from a full link; absent for read-only (view) links. */
	writeToken?: Uint8Array;
}

// ═══════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════
// Ask-dialog option labels
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Marker the ask dialog appends to the recommended option's label.
 *
 * The producer is the TUI, which bakes the marker into the label text it shows
 * and returns. Every consumer that reports the answer has to take it back off:
 * the dialog itself, the ask tool, and the HTML/collab renderer in
 * `@veyyon/tool-render`. Those four sites each carried their own copy of the
 * literal, so changing the wording in the writer left the readers matching a
 * string nobody produced any more, and the marker survived into the answer the
 * model was told the user picked. This is the one definition.
 */
export const RECOMMENDED_SUFFIX = " (Recommended)";

/** Append {@link RECOMMENDED_SUFFIX} unless `label` already carries it. */
export function withRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label : label + RECOMMENDED_SUFFIX;
}

/** Remove a trailing {@link RECOMMENDED_SUFFIX}, leaving any other label untouched. */
export function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

// ═══════════════════════════════════════════════════════════════════════════
// Todo status vocabulary
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every todo status, paired with the one question every surface asks of it:
 * has the task closed?
 *
 * This map is the definition. {@link TodoStatus} is derived from its keys, so a
 * new status cannot join the union without a terminality decision landing here
 * with it, and `Record<TodoStatus, …>` tables elsewhere stop compiling until
 * they answer for it too.
 *
 * It lives in `@veyyon/wire` because both renderers of a todo board need it and
 * they sit on opposite sides of a runtime boundary: the TUI renderer in
 * `@veyyon/coding-agent` (`src/tools/todo.ts`) and the HTML/collab renderer in
 * `@veyyon/tool-render`, which cannot import from coding-agent. Two private
 * copies of the vocabulary is how one renderer ends up calling a board finished
 * while the other still draws it open.
 */
export const TODO_STATUS_IS_TERMINAL = {
	pending: false,
	in_progress: false,
	completed: true,
	abandoned: true,
} as const;

export type TodoStatus = keyof typeof TODO_STATUS_IS_TERMINAL;

/** Every status in {@link TODO_STATUS_IS_TERMINAL}, for enumeration at run time. */
export const TODO_STATUSES: readonly TodoStatus[] = Object.keys(TODO_STATUS_IS_TERMINAL) as TodoStatus[];

/**
 * A status no further work is expected on. The complement is open work.
 *
 * Compared against `true` rather than returned raw: the argument is typed, but
 * the values behind it come off session files and wire frames, and a board
 * carrying `status: "toString"` reached `TODO_STATUS_IS_TERMINAL["toString"]`
 * and got `Object.prototype.toString` back — a truthy function that read as
 * CLOSED and collapsed a board with open work on it.
 */
export function isTerminalTodoStatus(status: TodoStatus): boolean {
	return TODO_STATUS_IS_TERMINAL[status] === true;
}

/**
 * Narrow arbitrary JSON (a transcript, a wire frame) to a status; anything
 * unknown reads as open.
 *
 * Own keys only. `in` walks the prototype chain, so every `Object.prototype`
 * member name passed this check and came back out typed as a status.
 */
export function asTodoStatus(value: unknown): TodoStatus {
	return typeof value === "string" && Object.hasOwn(TODO_STATUS_IS_TERMINAL, value)
		? (value as TodoStatus)
		: "pending";
}

/** The single line a finished todo board collapses to, on every surface. */
export const TODO_DONE_SUMMARY = "Todo list done";

/**
 * The board holds work and all of it is closed.
 *
 * Renderers call this on the phases in hand and collapse to
 * {@link TODO_DONE_SUMMARY} when it holds. Nothing caches the answer: it is a
 * function of the current board, so appending a pending task reopens the list
 * on the very next frame. An empty board is not "done" — there was nothing to
 * finish.
 */
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
