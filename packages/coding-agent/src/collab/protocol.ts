/**
 * Collab live-session wire protocol.
 * Hub topology: host is authoritative, payloads are AES-256-GCM sealed, relay sees only plaintext envelopes.
 */

import type { Usage as AgentUsage, ImageContent, Model } from "@veyyon/ai";
// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type {
	BusChannel,
	CollabUiRequest,
	GuestFrame,
	ParsedCollabLink,
	Participant,
	SessionState,
	AgentEvent as WireAgentEvent,
	AgentSnapshot as WireAgentSnapshot,
	WireAssistantMessage,
	// The nullable wire shape, not the extension API's `ContextUsage`: a host with no
	// anchor yet (right after a compaction) has to be able to say "unknown" to a
	// guest, and the browser client already reads these three fields as nullable.
	ContextUsage as WireContextUsage,
	WireMessage,
	WireModel,
	WireSessionEntry,
	WireSessionHeader,
	WireUsage,
} from "@veyyon/wire";
import {
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	WRITE_TOKEN_BYTES,
} from "@veyyon/wire";

import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "../session/session-entries";

export type {
	CollabPromptDetails,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	CollabUiSelectItem,
	ParsedCollabLink,
	RelayControlMessage,
	RelayControlToGuest,
	RelayControlToHost,
} from "@veyyon/wire";
export { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO } from "@veyyon/wire";
export { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES };

export type CollabParticipant = Participant;
export type AgentSnapshot = WireAgentSnapshot;

/**
 * Project host session header to explicit wire fields, preventing undeclared host
 * fields from leaking to guest replicas.
 */
export function toWireSessionHeader(header: SessionHeader): WireSessionHeader {
	return { type: "session", id: header.id, title: header.title, timestamp: header.timestamp, cwd: header.cwd };
}

/**
 * Project the host's token accounting onto the six numbers a guest renders.
 *
 * The host's `Usage` also carries provider-side orchestration counts, a Copilot premium-request
 * counter, a reasoning-token subset, and a cost breakdown per bucket. A guest draws one total.
 */
function toWireUsage(usage: AgentUsage): WireUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { total: usage.cost.total },
	};
}

/**
 * Project host messages onto declared wire shapes, stripping internal provider
 * payloads, turn metrics, steering, and attribution before broadcast.
 */
function toWireMessage(message: SessionMessageEntry["message"]): WireMessage {
	switch (message.role) {
		case "user":
			return {
				role: "user",
				content: message.content,
				synthetic: message.synthetic,
				timestamp: message.timestamp,
			};
		case "developer":
			return { role: "developer", content: message.content, timestamp: message.timestamp };
		case "assistant":
			return {
				role: "assistant",
				content: message.content as WireAssistantMessage["content"],
				model: message.model,
				provider: message.provider,
				usage: toWireUsage(message.usage),
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				timestamp: message.timestamp,
			};
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				// Declared by the wire contract: a guest renders a tool result from it, and the
				// tool's own detail shape is what tells it how.
				details: message.details,
				isError: message.isError,
				timestamp: message.timestamp,
			};
		// The seven roles that come from the host's `CustomAgentMessages` hook. A guest renders all
		// of them, so they travel; each is projected onto its declared shape like the four above.
		case "bashExecution":
			return {
				role: "bashExecution",
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				signal: message.signal,
				cancelled: message.cancelled,
				truncated: message.truncated,
				// Drawn in full by the output-notice formatter; declared `unknown` by contract.
				meta: message.meta,
				excludeFromContext: message.excludeFromContext,
				timestamp: message.timestamp,
			};
		case "pythonExecution":
			return {
				role: "pythonExecution",
				code: message.code,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				// Drawn in full by the output-notice formatter; declared `unknown` by contract.
				meta: message.meta,
				excludeFromContext: message.excludeFromContext,
				timestamp: message.timestamp,
			};
		case "custom":
		case "hookMessage":
			return {
				role: message.role,
				customType: message.customType,
				content: message.content,
				display: message.display,
				// Declared `unknown` by contract: an extension owns this shape and the renderer it
				// registered owns the drawing, so nothing here can narrow it. `attribution` is NOT
				// carried: it records who to bill for the turn, which is host bookkeeping.
				details: message.details,
				timestamp: message.timestamp,
			};
		case "branchSummary":
			return {
				role: "branchSummary",
				summary: message.summary,
				fromId: message.fromId,
				timestamp: message.timestamp,
			};
		case "compactionSummary":
			return {
				role: "compactionSummary",
				summary: message.summary,
				shortSummary: message.shortSummary,
				tokensBefore: message.tokensBefore,
				warning: message.warning,
				timestamp: message.timestamp,
			};
		case "fileMention":
			return {
				role: "fileMention",
				files: message.files.map(file => ({
					path: file.path,
					// The body is the whole point of this arm's projection: a mention of a large file
					// would otherwise send its full text to every guest on two frames.
					hasContent: file.content.length > 0,
					lineCount: file.lineCount,
					byteSize: file.byteSize,
					skippedReason: file.skippedReason,
					image: file.image,
				})),
				timestamp: message.timestamp,
			};
	}
}

/**
 * Project a stored session entry onto its wire variant, returning undefined for
 * unrendered entry types to prevent undeclared fields reaching guests.
 */
export function toWireSessionEntry(entry: SessionEntry): WireSessionEntry | undefined {
	const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message":
			return { ...base, type: "message", message: toWireMessage(entry.message) };
		case "custom_message":
			return {
				...base,
				type: "custom_message",
				customType: entry.customType,
				content: entry.content,
				// Declared: `collab-prompt` entries carry the guest's identity here, and that is
				// what makes a guest's own prompt render as theirs rather than as the host's.
				details: entry.details,
				display: entry.display,
			};
		case "compaction":
			return {
				...base,
				type: "compaction",
				summary: entry.summary,
				shortSummary: entry.shortSummary,
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
			};
		case "branch_summary":
			return { ...base, type: "branch_summary", fromId: entry.fromId, summary: entry.summary };
		case "model_change":
			return { ...base, type: "model_change", model: entry.model, role: entry.role };
		case "thinking_level_change":
			return { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
		default:
			return undefined;
	}
}

/**
 * Project host session events onto wire events, delegating message shapes to
 * {@link toWireMessage} and returning undefined for unrendered event types.
 */
export function toWireAgentEvent(event: AgentSessionEvent): WireAgentEvent | undefined {
	switch (event.type) {
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
			// Deliberately payload-free. See the note above: the host's `agent_end` carries every
			// message of the run and `turn_end` carries the turn plus its tool results.
			return { type: event.type };
		case "message_start":
		case "message_update":
		case "message_end":
			return { type: event.type, message: toWireMessage(event.message) };
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		case "notice":
			return { type: "notice", level: event.level, message: event.message, source: event.source };
		case "auto_compaction_start":
			// Both fields are declared and both are plain strings: `reason` is why compaction ran
			// and `action` is which strategy the engine chose.
			return { type: "auto_compaction_start", reason: event.reason, action: event.action };
		case "auto_compaction_end":
			// `result` is the full `CompactionResult`, which holds the summary and its accounting.
			return {
				type: "auto_compaction_end",
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			};
		case "auto_retry_start":
			// `errorId` is the host's internal error identity, used to correlate its own logs.
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				// A guest renders the countdown too, so it needs to know whether the
				// host is resending the turn or carrying an unreplayable batch forward.
				mode: event.mode,
			};
		case "auto_retry_end":
			// `recoveredErrors` carries the host's per-attempt error records.
			return {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				mode: event.mode,
			};
		case "thinking_level_changed":
			// `configured` and `resolved` are the user's selector and what auto mode picked, both
			// host state; a guest renders the effective level.
			return { type: "thinking_level_changed", thinkingLevel: event.thinkingLevel };
		default:
			return undefined;
	}
}

/**
 * Widen received wire entries back into host entry shapes for guest replica sessions,
 * populating unbroadcast transport fields like `api` with placeholder markers.
 */
export function fromWireSessionEntry(entry: WireSessionEntry): SessionEntry {
	if (entry.type === "message" && entry.message.role === "fileMention") {
		// The host sends `hasContent` and not the body. The replica's own type wants a `content`
		// string, so it gets an empty one plus a flag saying it was never sent -- an empty string on
		// its own would be indistinguishable from a file that really was empty, and an export would
		// then print a blank block as though it had read one.
		return {
			...entry,
			message: {
				...entry.message,
				files: entry.message.files.map(file => ({
					...file,
					content: "",
					contentNotReplicated: file.hasContent,
				})),
			},
		} as unknown as SessionEntry;
	}
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry as SessionEntry;
	return {
		...entry,
		message: { ...entry.message, api: WIRE_API_UNREPORTED },
	} as unknown as SessionEntry;
}

/**
 * The `api` of an assistant turn a guest received over the wire.
 *
 * Not a real endpoint name and deliberately not one: the host does not send `api`, so anything that
 * looks like an endpoint here would be a fabrication that a replica file then records as fact.
 */
export const WIRE_API_UNREPORTED = "unreported-over-wire";

/**
 * Widen received wire events into host event shapes for guest controllers,
 * using {@link WIRE_API_UNREPORTED} for omitted assistant `api` fields.
 */
export function fromWireAgentEvent(event: WireAgentEvent): AgentSessionEvent {
	if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
		return event as AgentSessionEvent;
	}
	if (event.message.role !== "assistant") return event as AgentSessionEvent;
	return {
		...event,
		message: { ...event.message, api: WIRE_API_UNREPORTED },
	} as unknown as AgentSessionEvent;
}

/**
 * Placeholder `baseUrl` for guest wire models to satisfy required model fields
 * without exposing real host provider endpoints.
 */
export const WIRE_MODEL_NO_ENDPOINT = "collab-guest://no-provider-endpoint";

/**
 * Placeholder `api` dialect string for models received over the wire.
 */
export const WIRE_MODEL_API_UNREPORTED = "unreported-over-wire";

/**
 * Project host catalog models onto wire model shapes, stripping internal endpoints,
 * headers, pricing, and provider-specific thinking maps.
 */
export function toWireModel(model: Model): WireModel {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		contextWindow: model.contextWindow,
		reasoning: model.reasoning,
		thinking: model.thinking
			? {
					mode: model.thinking.mode,
					efforts: [...model.thinking.efforts],
					defaultLevel: model.thinking.defaultLevel,
				}
			: undefined,
	};
}

/**
 * Widen received wire models into `Model` objects for replica state, filling
 * unbroadcast provider endpoints and pricing with inert placeholder values.
 */
export function fromWireModel(model: WireModel): Model {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider as Model["provider"],
		contextWindow: model.contextWindow,
		reasoning: model.reasoning ?? false,
		thinking: model.thinking
			? {
					mode: model.thinking.mode as NonNullable<Model["thinking"]>["mode"],
					efforts: model.thinking.efforts as NonNullable<Model["thinking"]>["efforts"],
					defaultLevel: model.thinking.defaultLevel as NonNullable<Model["thinking"]>["defaultLevel"],
				}
			: undefined,
		api: WIRE_MODEL_API_UNREPORTED as Model["api"],
		baseUrl: WIRE_MODEL_NO_ENDPOINT,
		input: ["text"],
		maxTokens: null,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricing: "unknown",
		compat: {} as Model["compat"],
	};
}

/** Debounced footer snapshot broadcast by the host. */
export type CollabSessionState = SessionState & {
	/**
	 * Wire model representation (narrowed via {@link toWireModel}) for guest status
	 * lines and replica state.
	 */
	model?: WireModel;
	/** Host status-line context numbers (guest system prompt/tools differ, so local estimates drift). */
	contextUsage?: WireContextUsage;
};

/**
 * Project status-line context usage into wire format, preserving nulls when no
 * assistant turn exists to anchor token counts.
 */
export function contextUsageFrame(breakdown: { usedTokens: number | null; contextWindow: number }): WireContextUsage {
	const { usedTokens, contextWindow } = breakdown;
	return {
		tokens: usedTokens,
		contextWindow,
		// A zero window is a model whose window the host does not know either; the
		// percentage is 0 rather than null because the tokens ARE known and the guest's
		// own limit resolution takes over from the window it was handed.
		percent: usedTokens === null ? null : contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0,
	};
}

/**
 * Encrypted payload frames (inside AES-GCM, JSON). The wire package pins the
 * JSON skeleton (`WireFrame`); host-side frames carry the rich session types
 * that serialize into those shapes.
 */
export type CollabFrame =
	// guest -> host (hello/abort/agent-cmd/fetch-transcript/ui-response are taken verbatim from the wire grammar)
	| Exclude<GuestFrame, { t: "prompt" }>
	| { t: "prompt"; text: string; images?: ImageContent[] }
	// host -> guest
	| {
			t: "welcome";
			proto: number;
			/**
			 * Wire header projected via {@link toWireSessionHeader} to prevent leaking
			 * host cache keys or internal parent session IDs.
			 */
			header: WireSessionHeader;
			state: CollabSessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. The guest stays in the
			 * snapshot-loading phase until it has accumulated that many entries
			 * (or a chunk arrives with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
	  }
	/**
	 * Targeted snapshot fragment delivering large transcripts in chunks so guest
	 * timeouts reset per batch; `final: true` marks completion.
	 */
	/**
	 * Projected wire entries (narrowed via {@link toWireSessionEntry}).
	 */
	| { t: "snapshot-chunk"; entries: WireSessionEntry[]; final: boolean }
	| { t: "entry"; entry: WireSessionEntry }
	/**
	 * A wire event, not the host's. Build it with {@link toWireAgentEvent}.
	 *
	 * The host's `AgentSessionEvent` is far wider: `agent_end` alone carries every message of the
	 * run. Typing the frame as the host's own is what let all of it through.
	 */
	| { t: "event"; event: WireAgentEvent }
	| { t: "state"; state: CollabSessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	/** Full agent-registry snapshot (debounced on registry change). */
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `error` marks a terminal read failure that guests must surface without hot retrying. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

// ═══════════════════════════════════════════════════════════════════════════
// Wire envelope: [4B uint32 BE peerId][sealed payload]
// Host→relay: peerId 0 broadcasts to all guests; peerId N targets guest N.
// Guest→relay: always 0; the relay rewrites it to the sender's id.
//
// The codec itself belongs to `@veyyon/wire`, alongside the header length, so
// the host and the browser guest cannot disagree about the byte order. It is
// re-exported here because `protocol.ts` is what the collab host and guest
// import.
// ═══════════════════════════════════════════════════════════════════════════

export { packEnvelope, rewriteEnvelopePeer, unpackEnvelope } from "@veyyon/wire";

// ═══════════════════════════════════════════════════════════════════════════
// Link format: wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>
// ═══════════════════════════════════════════════════════════════════════════

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

function isLocalHostname(hostname: string): boolean {
	return LOCAL_HOSTNAMES[hostname] === true;
}

export function generateRoomId(): string {
	const bytes = new Uint8Array(ROOM_ID_BYTES);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

/** Normalize a relay base URL (ws/wss/http/https) into a ws/wss origin, or an error. */
function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && !isLocalHostname(url.hostname)) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

/**
 * Format collab link payload (`<roomId>.<key>`), using dot separators to avoid
 * raw `#` characters that get percent-encoded in browser deep links.
 */
function formatCollabLinkPayload(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken: Uint8Array | undefined,
	joiner: string,
): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	const secret = writeToken ? Buffer.concat([key, writeToken]) : Buffer.from(key);
	const keyText = secret.toString("base64url");
	// The default relay collapses to a hostless `<roomId>.<key>`. There is no
	// authority for a terminal to linkify, so the secret cannot become a
	// request line, and the dot is required: this exact text is what gets
	// nested in the web deep link's fragment.
	if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
	const compact = normalized.origin.startsWith("wss://")
		? normalized.origin.slice("wss://".length)
		: normalized.origin;
	return `${compact}/r/${roomId}${joiner}${keyText}`;
}

/**
 * Render shareable collab link with secrets placed in the URL fragment (`#<key>`)
 * so room keys never leak into relay HTTP request lines or server access logs.
 */
export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array): string {
	return formatCollabLinkPayload(relayUrl, roomId, key, writeToken, "#");
}

function normalizeCollabWebBaseUrl(relayUrl: string, webUrl?: string): string {
	const explicitWebUrl = webUrl?.trim();
	if (!explicitWebUrl) {
		const normalized = normalizeRelayOrigin(relayUrl);
		if ("error" in normalized) throw new Error(normalized.error);
		return normalized.origin.startsWith("wss://")
			? `https://${normalized.origin.slice("wss://".length)}`
			: `http://${normalized.origin.slice("ws://".length)}`;
	}

	let url: URL;
	try {
		url = new URL(explicitWebUrl);
	} catch {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol === "http:" && !isLocalHostname(url.hostname)) {
		throw new Error("collab.webUrl must use https:// unless it targets localhost");
	}
	if (url.search || url.hash) {
		throw new Error("collab.webUrl must not include a query string or fragment");
	}
	const path = trimTrailingSlashes(url.pathname);
	return `${url.origin}${path}`;
}

/**
 * Render browser deep link with dot-joined collab payload in the fragment so room
 * secrets stay out of HTTP request paths.
 */
export function formatCollabWebLink(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken?: Uint8Array,
	webUrl?: string,
): string {
	const payload = formatCollabLinkPayload(relayUrl, roomId, key, writeToken, ".");
	return `${normalizeCollabWebBaseUrl(relayUrl, webUrl)}/#${payload}`;
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	// Lenient input: terminals that open OSC 8 links through strict URL stacks
	// (macOS Foundation) percent-encode the legacy second `#` to `%23`.
	let text = link.trim().replace(/%23/gi, "#");
	// Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) → default relay.
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
	// Scheme-less `host[:port]/r/…` → wss.
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		const parsed = parseCollabLink(inner);
		if (!("error" in parsed)) return parsed;
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		// Non-http(s) deep links may also carry a complete collab link in the
		// fragment. http(s) links are handled once above so invalid fragments
		// fall through to direct relay validation instead of double-recursing.
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1]!;
	// Key rides dot-joined in the path (`/r/<roomId>.<key>`); legacy links
	// carry it in the fragment (`/r/<roomId>#<key>`).
	const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) {
		return { error: "Collab link is missing the <key> part" };
	}
	const secret = B64URL_RE.test(fragment) ? new Uint8Array(Buffer.from(fragment, "base64url")) : null;
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}
