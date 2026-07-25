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

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

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

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g. auto-continue). */
	synthetic?: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	usage: WireUsage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type WireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

// ═══════════════════════════════════════════════════════════════════════════
// Session entries (rendered subset; cast `as SessionEntry` at the JSON
// boundary and skip unknown `type`s in a tolerant `default:`)
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

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

export type SessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

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
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "thinking_level_changed"; thinkingLevel?: string };

// ═══════════════════════════════════════════════════════════════════════════
// State & agents
// ═══════════════════════════════════════════════════════════════════════════

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
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
			header: SessionHeader;
			state: SessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
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
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
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
	const iv = new Uint8Array(SEAL_IV_BYTES);
	crypto.getRandomValues(iv);
	const plaintext = SEAL_TEXT_ENCODER.encode(JSON.stringify(frame));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(SEAL_IV_BYTES + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, SEAL_IV_BYTES);
	return out;
}

/**
 * Inverse of {@link sealFrame}. Throws on authentication failure or malformed input.
 *
 * The caller names the frame type it expects; this does not validate it. The seal proves the frame
 * came from someone holding the room key, and the frame grammar is checked where it is handled.
 */
export async function openFrame<Frame>(key: CryptoKey, data: Uint8Array): Promise<Frame> {
	if (data.byteLength <= SEAL_IV_BYTES) {
		throw new Error("Sealed frame too short");
	}
	// Both slices are copied rather than viewed. WebCrypto reads a view's whole backing buffer, and
	// neither of these spans its own: the ciphertext always sits behind the IV.
	const iv = new Uint8Array(data.subarray(0, SEAL_IV_BYTES));
	const ciphertext = new Uint8Array(data.subarray(SEAL_IV_BYTES));
	const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
	return JSON.parse(SEAL_TEXT_DECODER.decode(plaintext)) as Frame;
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
// Relay control messages (TEXT JSON, unencrypted, no session data)
// ═══════════════════════════════════════════════════════════════════════════

/** Relay → host control message. */
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
/** Relay → guest control message. */
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;
