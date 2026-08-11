/**
 * Collab live-session wire protocol.
 *
 * Hub topology: the host is authoritative, guests never peer. All session
 * payloads (`CollabFrame`) travel AES-256-GCM sealed; the relay only sees the
 * plaintext envelope (`[4B uint32 BE peerId][sealed payload]`) plus TEXT JSON
 * control messages that carry no session data.
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
import type { ContextUsage } from "../extensibility/extensions/types";
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
 * Project the host's session header onto the four fields the wire contract declares.
 *
 * Every field the host adds to its header would otherwise reach every guest and be persisted in
 * their replica session file, because assignability runs the permissive way: the host's header
 * satisfies the wire type while carrying more. Written out field by field rather than as a
 * destructuring rest, so adding a field to the host's header does NOT silently start shipping it.
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
 * Project one of the host's messages onto the shape the wire contract declares.
 *
 * The assistant arm is the one that matters. The host's `AssistantMessage` carries
 * `providerPayload` (transport-native history used to replay the turn upstream), `request` (the
 * sampling and reasoning parameters exactly as sent), `contextSnapshot`, `retryRecovery`,
 * `turnMetrics`, `stopDetails`, `errorId`, `errorStatus`, `responseId`, `upstreamProvider`,
 * `disabledFeatures`, `toolCallAbortMessages`, `api`, `provider`, `duration` and `ttft`. None of
 * them is drawn by a guest, several are large, and guests persist what they receive into their own
 * replica session file, so an undeclared field lands on another machine's disk.
 *
 * `steering` and `attribution` come off the user and developer arms for the same reason, and
 * `prunedAt`, `useless` and `metrics` off tool results.
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
 * Project one stored session entry onto the wire variant a guest renders.
 *
 * Same reason as {@link toWireSessionHeader}, one frame over, and the same discipline: written out
 * field by field rather than as a destructuring rest, so a field added to a host entry does NOT
 * start shipping on its own. `isWireSessionEntry` in `host.ts` narrows the TYPE and leaves the
 * VALUE alone, which is what let every extra field through.
 *
 * Returns `undefined` for an entry type no guest renders, so callers filter and project in one
 * step and cannot broadcast an entry that was never projected.
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
 * Project one host session event onto the event the wire contract declares.
 *
 * The third door of the same defect, and the widest one. `agent_end` carries the host's ENTIRE
 * message array; the wire declares `{ type: "agent_end" }` with no payload at all, and the host was
 * broadcasting the whole conversation, every provider payload in it included, at the end of every
 * run. `turn_end` carries the turn's message and every tool result and declares neither.
 * `message_start`, `message_update` and `message_end` carry a full host message, and
 * `message_update` fires once per streaming delta, which makes it the highest-frequency frame there
 * is. All of that crossed a relay somebody else runs and reached read-only viewers.
 *
 * The three message arms delegate to {@link toWireMessage} rather than repeating it: one projection
 * per shape, so an entry and an event cannot disagree about what a guest receives for the same
 * message.
 *
 * The `tool_execution_*` arms pass `args`, `partialResult` and `result` through, and that is the
 * contract rather than an omission: the wire declares them `unknown` because a tool's arguments and
 * result are the tool's own shape, and a guest renders them by asking the tool how. So the tool
 * result fields a projection would otherwise strip (`prunedAt`, `useless`, `metrics`) are permitted
 * here, not leaked. Widening them silently would be the mistake; saying so is the point.
 *
 * Returns `undefined` for an event no guest renders, so filtering and projecting are one step.
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
 * Widen a received wire entry back into the host entry shape a guest's replica session is made of.
 *
 * The counterpart to {@link toWireSessionEntry}, and the reason it is a real function rather than a
 * cast: a guest does not merely display what it receives, it writes the entries into its own
 * replica session file and pushes assistant turns into the agent's message array, which is typed as
 * the host's own message. Before the projection existed the guest got the host's `api` field for
 * free, as part of the leak this function's counterpart closed.
 *
 * `api` is the one field that has to be invented, and it is filled with a marker that says so
 * rather than with a plausible endpoint name. `api` is the transport endpoint the host's request
 * went to; a guest has no way to know it and nothing it draws depends on it, so guessing a real
 * value would put a wrong answer in a replica that other tooling reads. `provider` is NOT invented,
 * because the wire contract declares it: a replica that cannot say what answered is not faithful.
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
 * Widen a received wire event back into the host event shape a guest's controller expects.
 *
 * The counterpart to {@link toWireAgentEvent}, and the same trade {@link fromWireSessionEntry}
 * makes: a guest hands events to a controller typed against the host's own union, so the assistant
 * arms need an `api` the host does not send. It is filled with {@link WIRE_API_UNREPORTED} rather
 * than an endpoint name, because a plausible-looking value would be a fabrication that a guest then
 * renders and persists.
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
 * The `baseUrl` of a model a guest received over the wire.
 *
 * A guest's replica agent state wants a `Model`, and `Model.baseUrl` is required, so the field has
 * to hold something. It holds a scheme nothing dials rather than a plausible URL: the host's real
 * endpoint is the field this projection exists to keep off the wire, and an empty string or a
 * default endpoint would be a silent fallback that turns "we never send this" into "we quietly send
 * you somewhere else". Anything that tried to open it fails immediately and says why.
 */
export const WIRE_MODEL_NO_ENDPOINT = "collab-guest://no-provider-endpoint";

/**
 * The `api` of a model a guest received over the wire.
 *
 * Same trade as {@link WIRE_API_UNREPORTED} one level up, for the same reason: `Model.api` selects
 * a request dialect, a guest never issues a request, and a real dialect name here would be a guess
 * recorded as fact.
 */
export const WIRE_MODEL_API_UNREPORTED = "unreported-over-wire";

/**
 * Project the host's catalog model onto the four-to-six fields a guest draws.
 *
 * Written out field by field, not spread. The host's `Model` has 34 fields and the ones that matter
 * most here are the ones a reader would never think to check: `baseUrl` is the provider endpoint,
 * which on a gateway-routed or self-hosted configuration is an internal host, and the state frame
 * re-broadcasts every couple of seconds while streaming, to every guest including read-only
 * viewers. `cost`, `headers`, `requestModelId` and `compat` ride along the same way.
 *
 * The thinking config is narrowed rather than passed through for the same reason: `efforts` and
 * `defaultLevel` are what the status line and the level picker read, while `effortMap`,
 * `effortRouting` and the per-effort budgets exist to encode an effort into a provider wire field,
 * which only the host ever does.
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
 * Widen a received wire model back into the `Model` a guest's replica agent state holds.
 *
 * The counterpart to {@link toWireModel}. Every field the host did not send is filled with a value
 * that is inert rather than plausible: {@link WIRE_MODEL_NO_ENDPOINT} for the endpoint,
 * {@link WIRE_MODEL_API_UNREPORTED} for the dialect, zero pricing marked `"unknown"` so nothing
 * reads the zeros as "free", and an empty compat record. None of them is reachable, because a guest
 * forwards prompts to the host and never builds a request; they exist so the type is satisfied
 * honestly instead of by a cast.
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
	 * The wire model, not the host's catalog model. Build it with {@link toWireModel}.
	 *
	 * This used to be typed `Model` on purpose, so a guest could apply the host's real model to its
	 * replica and get native display and context-window numbers. The intent was right and the type
	 * was wrong: the catalog `Model` carries the provider endpoint, the pricing table and the
	 * compatibility record, none of which a guest draws, and the wire contract already declared a
	 * four-field `WireModel`, so the contract and the value disagreed. Typing the field as the wire
	 * model is what makes the compiler ask for the projection.
	 */
	model?: WireModel;
	/** Host status-line context numbers (guest system prompt/tools differ, so local estimates drift). */
	contextUsage?: ContextUsage;
};

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
			 * The wire header, not the host's. Build it with {@link toWireSessionHeader}.
			 *
			 * The host's own `SessionHeader` is assignable to the wire one, so this used to be typed
			 * as the host's and `snapshot.header` went out verbatim -- carrying `titleSource`,
			 * `parentSession` and `providerPromptCacheKey`, three fields the wire contract does not
			 * declare, to every guest including read-only viewers. The guest writes the header it
			 * received straight into its replica session file, so the host's provider prompt-cache
			 * identity was being persisted on other people's machines. Naming the narrow type here
			 * makes the projection the compiler's business rather than a thing to remember.
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
	 * Targeted snapshot fragment delivered after `welcome`. Splits a large
	 * transcript across many small frames so the guest's per-chunk progress
	 * timeout resets each time the relay delivers another batch; without
	 * chunking, a multi-MB session has to fit one giant frame inside the
	 * 30 s first-welcome budget. The last chunk carries `final: true` so the
	 * guest can finalize the replica session.
	 */
	/**
	 * Wire entries, not the host's. Build them with {@link toWireSessionEntry}.
	 *
	 * Typed as the narrower shape on purpose. Declaring the host's `SessionEntry` here is what let
	 * every undeclared field reach every guest: assignability runs the permissive way, so a host
	 * entry satisfies a wire type while carrying twenty more fields, and the guest persists what it
	 * receives into its own replica session file.
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
 * Render the payload half of a link: `<roomId>.<key>` for the default relay,
 * `host[:port]/r/<roomId>.<key>` for another wss relay, and a full URL for a
 * localhost ws:// relay so parsing cannot mis-infer wss.
 *
 * The room secret is dot-joined rather than `#`-joined because this text gets
 * nested inside the fragment of the browser deep link: RFC 3986 forbids a raw
 * `#` inside a fragment, so strict URL stacks (macOS Foundation behind
 * terminal click-to-open) percent-encode a second `#` to `%23` and break the
 * link. Parsers accept the `#` form and the mangled `%23` form too.
 *
 * Full links append the write token to the key
 * (`base64url(key ∥ writeToken)`); read-only (view) links carry the bare
 * 32-byte key, which is also the pre-token link format.
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
 * Render the shareable link a human sees and pastes.
 *
 * When the link names a relay host, the secret rides in the fragment
 * (`host/r/<roomId>#<key>`) and never in the path. Terminals linkify
 * `host/r/…` and open it as `https://…`; with the secret dot-joined into the
 * path, one click on your own link puts the AES-256-GCM room key and the
 * write token in the relay's HTTP request line, and from there into its
 * access log and any TLS-terminating proxy in front of it. A fragment is
 * never sent to the server, so a click discloses only `/r/<roomId>`, which
 * the WebSocket handshake reveals anyway. That is what
 * `collab/crypto.ts` means by "the relay sees opaque bytes".
 *
 * Only one `#` appears here, so the nested-fragment escaping problem that
 * forces the dot-joined payload form does not apply.
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
 * Render the browser deep link. The browser UI may be hosted separately from
 * the relay; the fragment always carries the relay-specific collab link, so
 * room secrets stay out of HTTP path and query bytes.
 *
 * It nests the dot-joined payload, not the `#`-joined display link: a second
 * raw `#` inside a fragment is what strict URL stacks mangle to `%23`.
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
