import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import http2 from "node:http2";
import { setImmediate as yieldToProtocolEvents } from "node:timers/promises";
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { McpToolDefinition } from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	type AgentRunRequest,
	AgentRunRequestSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	AssistantMessageSchema,
	BackgroundShellSpawnResultSchema,
	ClientHeartbeatSchema,
	ComputerUseResultSchema,
	ConversationActionSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	type ConversationTokenDetails,
	ConversationTurnStructureSchema,
	DeleteErrorSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DeleteSuccessSchema,
	DiagnosticsErrorSchema,
	DiagnosticsRejectedSchema,
	DiagnosticsResultSchema,
	DiagnosticsSuccessSchema,
	ExecClientControlMessageSchema,
	type ExecClientMessage,
	ExecClientMessageSchema,
	ExecClientStreamCloseSchema,
	type ExecServerMessage,
	FetchErrorSchema,
	FetchResultSchema,
	GetBlobResultSchema,
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepCountResultSchema,
	GrepErrorSchema,
	type GrepFileCount,
	GrepFileCountSchema,
	GrepFileMatchSchema,
	GrepFilesResultSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	type GrepUnionResult,
	GrepUnionResultSchema,
	type InteractionUpdate,
	KvClientMessageSchema,
	type KvServerMessage,
	ListMcpResourcesExecResultSchema,
	type LsDirectoryTreeNode,
	type LsDirectoryTreeNode_File,
	LsDirectoryTreeNode_FileSchema,
	LsDirectoryTreeNodeSchema,
	LsErrorSchema,
	LsRejectedSchema,
	LsResultSchema,
	LsSuccessSchema,
	McpErrorSchema,
	McpImageContentSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolDefinitionSchema,
	McpToolNotFoundSchema,
	McpToolResultContentItemSchema,
	ModelDetailsSchema,
	ReadErrorSchema,
	ReadMcpResourceExecResultSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
	RecordScreenResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	RequestedModelSchema,
	ResumeActionSchema,
	SelectedContextSchema,
	SelectedImageSchema,
	SetBlobResultSchema,
	type ShellArgs,
	ShellFailureSchema,
	ShellRejectedSchema,
	type ShellResult,
	ShellResultSchema,
	type ShellStream,
	ShellStreamExitSchema,
	ShellStreamSchema,
	ShellStreamStartSchema,
	ShellStreamStderrSchema,
	ShellStreamStdoutSchema,
	ShellSuccessSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WriteErrorSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	WriteSuccessSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { calculateCost } from "@veyyon/catalog/models";
import { CURSOR_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { clampLow, logger } from "@veyyon/utils";
import { $env } from "@veyyon/utils/env";
import { parseJsonWithRepair, parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { errorMessage } from "@veyyon/utils/type-guards";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	CursorExecHandlerResult,
	CursorExecHandlers,
	CursorMcpCall,
	CursorShellStreamCallbacks,
	CursorToolResultHandler,
	ImageContent,
	Message,
	Model,
	ProviderContextBucket,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import {
	type CursorExecResolvedCarrier,
	clearStreamingPartialJson,
	kCursorExecResolved,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import {
	CONNECT_END_STREAM_FLAG,
	ConnectFrameReader,
	type ConnectRead,
	frameConnectMessage,
	MAX_CONNECT_FRAME_PAYLOAD,
} from "../utils/connect-frames";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";
import {
	createRequestDebugSession,
	isRequestDebugEnabled,
	type RequestDebugResponseLog,
	type RequestDebugSession,
} from "../utils/request-debug";
import { toolWireSchema } from "../utils/schema/wire";
import { type CursorLiveness, startCursorLiveness } from "./cursor-liveness";
import { createInitialResponsesAssistantMessage } from "./initial-message";

/**
 * Cursor's API host.
 *
 * Re-exported from `@veyyon/catalog/provider-endpoints`, which owns it, rather than declared here: this
 * package's usage reader and `catalog`'s discovery reader both need the same fallback, and this name is the
 * one callers already import.
 */
export const CURSOR_API_URL = CURSOR_API_ENDPOINT;
export const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

/**
 * Server silence that triggers an HTTP/2 PING, and the gap between probes.
 *
 * Short enough that a dead connection is reported in well under a minute, long enough that a healthy
 * turn costs one 8-byte frame every half minute.
 */
const CURSOR_LIVENESS_PROBE_INTERVAL_MS = 30_000;
/** How long one PING may go unacknowledged before the connection is declared dead. */
const CURSOR_LIVENESS_PROBE_TIMEOUT_MS = 10_000;
/**
 * Unbroken server silence that ends the turn even while the transport keeps answering.
 *
 * A PING is acknowledged by whatever terminates HTTP/2, which can be an edge in front of a wedged
 * backend, so liveness alone bounds nothing. Recorded healthy gaps between Cursor stream events
 * reach 355s, so this ceiling sits five times past observed behaviour: a remote agent that emits
 * nothing for half an hour is not working, it is stuck.
 */
const CURSOR_MAX_SILENT_MS = 30 * 60_000;

/**
 * A bounded, least-recently-used map. The cursor provider keys per-conversation
 * state and blob stores by conversationId; a plain module-level Map grew without
 * limit, so a long-lived process (an autonomous run touching many conversations,
 * or many short sessions with random ids) leaked one entry per conversation for
 * the process lifetime. This evicts the least-recently-used entry past `#max`.
 * `get`/`set` both refresh recency, so an actively-streamed conversation is
 * never evicted out from under an in-flight round.
 */
export class BoundedLruMap<K, V> {
	readonly #max: number;
	readonly #map = new Map<K, V>();
	constructor(max: number) {
		this.#max = max;
	}
	get(key: K): V | undefined {
		const value = this.#map.get(key);
		if (value !== undefined && this.#map.delete(key)) this.#map.set(key, value);
		return value;
	}
	set(key: K, value: V): void {
		this.#map.delete(key);
		this.#map.set(key, value);
		while (this.#map.size > this.#max) {
			const oldest = this.#map.keys().next().value;
			if (oldest === undefined) break;
			this.#map.delete(oldest);
		}
	}
}

/** Cap on distinct conversations kept warm; well past any single run's working
 *  set, small enough that the caches can never grow without bound. */
const CURSOR_CONVERSATION_CACHE_MAX = 128;
const conversationStateCache = new BoundedLruMap<string, ConversationStateStructure>(CURSOR_CONVERSATION_CACHE_MAX);
const conversationBlobStores = new BoundedLruMap<string, Map<string, Uint8Array>>(CURSOR_CONVERSATION_CACHE_MAX);

export interface CursorOptions extends StreamOptions {
	customSystemPrompt?: string;
	execHandlers?: CursorExecHandlers;
	onToolResult?: CursorToolResultHandler;
	/** Wire model uid selected after thinking-effort routing (see mapOptionsForApi). */
	wireModelId?: string;
}

interface CursorLogEntry {
	ts: number;
	type: string;
	subtype?: string;
	data?: unknown;
}

async function appendCursorDebugLog(entry: CursorLogEntry): Promise<void> {
	const logPath = $env.DEBUG_CURSOR_LOG;
	if (!logPath) return;
	try {
		await fs.appendFile(logPath, `${JSON.stringify(entry, debugReplacer)}\n`);
	} catch {
		// Ignore debug log failures
	}
}

function log(type: string, subtype?: string, data?: unknown): void {
	if (!$env.DEBUG_CURSOR) return;
	const normalizedData = data ? decodeLogData(data) : data;
	const entry: CursorLogEntry = { ts: Date.now(), type, subtype, data: normalizedData };
	const verbose = $env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose";
	const dataStr = verbose && normalizedData ? ` ${JSON.stringify(normalizedData, debugReplacer)?.slice(0, 500)}` : "";
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
	void appendCursorDebugLog(entry);
}

/**
 * A Connect/gRPC stream failure, mapped so the shared classifier can read it.
 *
 * THE WIRE SAYS THIS TWICE, IN TWO SPELLINGS: the end-stream JSON trailer carries
 * the code by name, the HTTP/2 trailers carry the numeric `grpc-status`. Both mean
 * the same failure, and both used to arrive as a bare `ProviderResponseError` with
 * an `envelope` kind, which classifies as nothing at all. So an `unavailable` or
 * an `internal` from Cursor failed the turn outright while the identical code from
 * Devin (same Connect protocol, same trailer) was retried and recovered.
 * {@link AIError.connectFailureStatus} is the one table both providers read; a code
 * it cannot place is a fault of the request itself and stays terminal.
 *
 * Exported for tests: the mapping is the whole retry decision for a Cursor stream
 * failure, and it has to be assertable next to Devin's for the same codes.
 */
export function cursorStreamFailure(code: string, message: string, label: string): Error {
	// A trailer often carries a code and no sentence at all, which used to render as a
	// dangling colon; the shared bound names an absent detail and caps a long one.
	const text = `${label} ${code}: ${AIError.boundProviderErrorDetail(message)}`;
	const failureStatus = AIError.connectFailureStatus({ code, message });
	if (failureStatus !== undefined) return new AIError.CursorApiError(text, failureStatus);
	return new AIError.ProviderResponseError(text, { provider: "cursor", kind: "envelope" });
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		const error = payload?.error;
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : "Unknown error";
			return cursorStreamFailure(code, message, "Connect error");
		}
		return null;
	} catch {
		// An unreadable end-stream frame means the terminal event never arrived in a
		// form this can act on, which is an incomplete stream and not a protocol
		// violation: the bytes were corrupted or truncated in transit.
		return new AIError.ProviderResponseError("Failed to parse Connect end stream", {
			provider: "cursor",
			kind: "incomplete-stream",
		});
	}
}

function debugBytes(bytes: Uint8Array, asHex: boolean): string {
	if (asHex) {
		return Buffer.from(bytes).toString("hex");
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (/^[\x20-\x7E\s]*$/.test(text)) return text;
	} catch {
		// A strict UTF-8 decode is the probe: bytes that are not text fall through
		// to the hex rendering below, which is the point of the function.
	}
	return Buffer.from(bytes).toString("hex");
}

function debugReplacer(key: string, value: unknown): unknown {
	if (
		value instanceof Uint8Array ||
		(value && typeof value === "object" && "type" in value && value.type === "Buffer" && "data" in value)
	) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array((value as { data: ArrayLike<number> }).data);
		const asHex = key === "blobId" || key === "blob_id" || key.endsWith("Id") || key.endsWith("_id");
		return debugBytes(bytes, asHex);
	}
	if (typeof value === "bigint") return value.toString();
	return value;
}

function extractLogBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value && typeof value === "object" && "type" in value && value.type === "Buffer") {
		const data = (value as { data?: number[] }).data;
		if (Array.isArray(data)) {
			return new Uint8Array(data);
		}
	}
	return null;
}

function decodeMcpArgsForLog(args?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	let mutated = false;
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		const bytes = extractLogBytes(value);
		if (bytes) {
			decoded[key] = decodeMcpArgValue(bytes);
			mutated = true;
			continue;
		}
		const normalizedValue = decodeLogData(value);
		decoded[key] = normalizedValue;
		if (normalizedValue !== value) {
			mutated = true;
		}
	}
	return mutated ? decoded : args;
}

function decodeLogData(value: unknown): unknown {
	if (!value || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(entry => decodeLogData(entry));
	}
	const record = value as Record<string, unknown>;
	const typeName = record.$typeName;
	const stripTypeName = typeof typeName === "string" && typeName.startsWith("agent.v1.");

	if (typeName === "agent.v1.McpArgs") {
		const decodedArgs = decodeMcpArgsForLog(record.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		return decodedArgs ? { ...base, args: decodedArgs } : base;
	}
	if (typeName === "agent.v1.McpToolCall") {
		const argsRecord = record.args as Record<string, unknown> | undefined;
		const decodedArgs = decodeMcpArgsForLog(argsRecord?.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		if (decodedArgs && argsRecord) {
			return { ...base, args: { ...argsRecord, args: decodedArgs } };
		}
		return base;
	}

	let mutated = stripTypeName;
	const decoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (stripTypeName && key === "$typeName") {
			continue;
		}
		const normalizedEntry = decodeLogData(entry);
		decoded[key] = normalizedEntry;
		if (normalizedEntry !== entry) {
			mutated = true;
		}
	}
	return mutated ? decoded : record;
}

function omitTypeName(record: Record<string, unknown>): Record<string, unknown> {
	const { $typeName: _, ...rest } = record;
	return rest;
}

/** Enough for any error envelope, and a bound against a proxy that answers a megabyte of HTML. */
const CURSOR_REFUSAL_BODY_LIMIT = 8 * 1024;
const CURSOR_HEARTBEAT_INTERVAL_MS = 5000;
const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";

function createBlockState(usage: CursorUsageAccount): BlockState {
	const state: BlockState = {
		currentTextBlock: null,
		currentThinkingBlock: null,
		currentToolCall: null,
		execDispatches: new Map<string, Promise<ExecReply>>(),
		firstTokenTime: undefined,
		usage,
		setTextBlock: block => {
			state.currentTextBlock = block;
		},
		setThinkingBlock: block => {
			state.currentThinkingBlock = block;
		},
		setToolCall: toolCall => {
			state.currentToolCall = toolCall;
		},
		setFirstTokenTime: () => {
			if (!state.firstTokenTime) state.firstTokenTime = performance.now();
		},
	};
	return state;
}

/** Pings `session`, settling when the peer acknowledges the PING. */
function pingSession(session: http2.ClientHttp2Session): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (session.closed || session.destroyed) {
		reject(new Error("the HTTP/2 session is already closed"));
		return promise;
	}
	const sent = session.ping((error: Error | null) => {
		if (error) reject(error);
		else resolve();
	});
	if (!sent) reject(new Error("the HTTP/2 session refused the ping"));
	return promise;
}

interface CursorRunStreamOptions {
	model: Model<"cursor-agent">;
	options: CursorOptions | undefined;
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	state: BlockState;
	h2Client: http2.ClientHttp2Session;
	h2Request: http2.ClientHttp2Stream;
	debugSession: RequestDebugSession | undefined;
	conversationId: string;
	blobStore: Map<string, Uint8Array>;
	systemPromptBlobIds: ReadonlySet<string>;
	requestContextTools: McpToolDefinition[];
}

/**
 * The HTTP/2 stream of one Cursor `Run` request: the Connect frames it answers with, the server
 * messages they carry, and the one decision of how the stream ended, delivered through
 * {@link CursorRunStream.settled}.
 */
class CursorRunStream {
	readonly #run: CursorRunStreamOptions;
	readonly #frames = new ConnectFrameReader();
	readonly #delivery: CursorTurnDelivery;
	readonly #onCheckpoint: (checkpoint: ConversationStateStructure) => void;
	readonly #outcome = Promise.withResolvers<void>();
	/**
	 * Settles when the turn has failed, so a termination waiting on in-flight message handlers stops
	 * waiting: a handler blocked on a local tool that never returns would otherwise hold the turn
	 * open after the failure that was meant to end it.
	 */
	readonly #failed = Promise.withResolvers<void>();
	readonly #pendingMessages = new Set<Promise<void>>();
	#failure: Error | undefined;
	#terminated = false;
	/**
	 * `turnEnded` is the only thing that says the server finished this turn. The HTTP/2 stream also
	 * ends when the connection stops, and those two are not the same event.
	 */
	#turnCompleted = false;
	/**
	 * A gateway that refuses answers with an HTTP status and a body, not with Connect frames, and
	 * the remedy for a `401`, a `429` or a proxy's error page belongs to the operator. A refusal body
	 * is collected instead of frame-parsed, and the shared bound names it.
	 */
	#refusedStatus: number | undefined;
	#refusalBody = "";
	#debugResponseLog: Promise<RequestDebugResponseLog | undefined> | undefined;
	#heartbeatTimer: NodeJS.Timeout | undefined;
	#liveness: CursorLiveness | undefined;

	constructor(run: CursorRunStreamOptions) {
		this.#run = run;
		this.#delivery = { systemPromptBlobIds: run.systemPromptBlobIds, onFatal: error => this.fail(error) };
		this.#onCheckpoint = checkpoint => {
			conversationStateCache.set(run.conversationId, checkpoint);
		};
	}

	/**
	 * Resolves when the server ended the turn, rejects with the reason it did not: an HTTP refusal,
	 * the first failure, or a stream that ended without `turnEnded`.
	 */
	get settled(): Promise<void> {
		return this.#outcome.promise;
	}

	/** Attaches to the stream and sends the request, its heartbeats and the liveness probes. */
	start(requestBytes: Uint8Array): void {
		const { h2Client, h2Request } = this.#run;
		h2Request.on("response", headers => this.#onResponse(headers));
		h2Request.on("data", (chunk: Buffer) => this.#onData(chunk));
		h2Request.write(frameConnectMessage(requestBytes));
		const heartbeat = frameConnectMessage(
			toBinary(
				AgentClientMessageSchema,
				create(AgentClientMessageSchema, {
					message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
				}),
			),
		);
		this.#heartbeatTimer = setInterval(() => this.#sendHeartbeat(heartbeat), CURSOR_HEARTBEAT_INTERVAL_MS);
		this.#liveness = this.#startLiveness();
		h2Request.on("trailers", trailers => this.#onTrailers(trailers));
		h2Request.on("end", () => this.#terminate());
		h2Request.on("close", () => this.#terminate());
		h2Request.on("error", (error: Error) => {
			this.fail(error);
			this.#terminate();
		});
		h2Client.on("error", (error: Error) => {
			this.fail(error);
			this.#terminate();
		});
		h2Client.on("close", () => this.#terminate());
		const signal = this.#run.options?.signal;
		if (!signal) return;
		// Already aborted before the listener attached: the event never fires, so the handler runs
		// once now instead of hanging the round.
		if (signal.aborted) this.#onAbort();
		else signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	/**
	 * Fails this turn: from a server-message handler, the liveness governor, a transport error or an
	 * abort. The first cause wins, so a later end-stream error cannot overwrite the reason the turn
	 * was abandoned, and a throw out of a message handler, which cannot stop the turn, routes here.
	 */
	fail(error: Error): void {
		if (this.#failure) return;
		this.#failure = error;
		this.#failed.resolve();
		this.#run.h2Request.close();
	}

	/**
	 * Stops the heartbeat and the liveness probes and detaches from the run's abort signal, which is
	 * shared across every round of a run, so a listener left attached pins this round's stream.
	 */
	async release(): Promise<void> {
		await this.#closeDebugLog();
		clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
		this.#liveness?.stop();
		this.#liveness = undefined;
		this.#run.options?.signal?.removeEventListener("abort", this.#onAbort);
	}

	readonly #onAbort = (): void => {
		const { h2Client, h2Request } = this.#run;
		try {
			h2Request.close();
		} catch {
			// Ignore close errors
		}
		try {
			if (!h2Client.closed && !h2Client.destroyed) h2Client.close();
		} catch {
			// Ignore close errors
		}
		this.fail(new AIError.RequestAbortError());
		this.#terminate();
	};

	/**
	 * Governs the turn by transport liveness plus a ceiling on time without progress: `cursor-agent`
	 * plans and executes on Cursor's side and emits no progress while it does, and its ten-second
	 * server heartbeat continues whether or not that work advances. A pinned stream idle budget is
	 * the ceiling.
	 */
	#startLiveness(): CursorLiveness {
		const idleBudget = this.#run.options?.streamIdleTimeoutMs;
		const maxSilentMs = idleBudget !== undefined && idleBudget > 0 ? idleBudget : CURSOR_MAX_SILENT_MS;
		const probeIntervalMs = clampLow(Math.floor(maxSilentMs / 3), 1, CURSOR_LIVENESS_PROBE_INTERVAL_MS);
		const { h2Client, stream } = this.#run;
		return startCursorLiveness({
			probeIntervalMs,
			probeTimeoutMs: Math.min(CURSOR_LIVENESS_PROBE_TIMEOUT_MS, probeIntervalMs),
			maxSilentMs,
			hasPendingLocalWork: () => stream.hasPendingLocalWork,
			probe: () => pingSession(h2Client),
			onDead: error => this.fail(error),
		});
	}

	#sendHeartbeat(frame: Buffer): void {
		const { h2Request } = this.#run;
		if (h2Request.closed || h2Request.destroyed) return;
		try {
			h2Request.write(frame);
		} catch {
			// Ignore heartbeat write failures on closing streams
		}
	}

	#onResponse(headers: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader): void {
		this.#liveness?.markProgress();
		const status = Number(headers[":status"]);
		if (Number.isFinite(status) && status >= 400) this.#refusedStatus = status;
		this.#debugResponseLog = this.#run.debugSession?.openResponseLog(
			`HTTP/2 ${headers[":status"] ?? ""}`.trim(),
			headers,
		);
	}

	#onTrailers(trailers: http2.IncomingHttpHeaders): void {
		const status = trailers["grpc-status"];
		if (!status || status === "0") return;
		const rawMessage = String(trailers["grpc-message"] || "");
		let message = rawMessage;
		try {
			message = decodeURIComponent(rawMessage);
		} catch {
			// Malformed percent-encoding in grpc-message should not crash event handler
		}
		this.fail(cursorStreamFailure(String(status), message, "gRPC error"));
	}

	#onData(chunk: Buffer): void {
		this.#liveness?.markTransport();
		if (this.#debugResponseLog) {
			void this.#debugResponseLog.then(log => {
				log?.write(chunk);
			});
		}
		if (this.#refusedStatus !== undefined) {
			if (this.#refusalBody.length < CURSOR_REFUSAL_BODY_LIMIT) this.#refusalBody += chunk.toString("utf8");
			return;
		}
		this.#frames.push(chunk);
		for (let read = this.#frames.next(); read; read = this.#frames.next()) {
			if (!this.#onFrame(read)) break;
		}
	}

	/** Handles one Connect frame; `false` stops reading the frames buffered behind it. */
	#onFrame(read: ConnectRead): boolean {
		if (read.kind === "oversized") {
			this.fail(
				new AIError.ProviderResponseError(
					`Cursor Connect frame length ${read.length} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
					{ provider: this.#run.model.provider, kind: "envelope" },
				),
			);
			return false;
		}
		if (read.flags & CONNECT_END_STREAM_FLAG) {
			const endError = parseConnectEndStream(read.payload);
			if (endError) this.fail(endError);
			return true;
		}
		let serverMessage: AgentServerMessage;
		try {
			serverMessage = fromBinary(AgentServerMessageSchema, read.payload);
		} catch (error) {
			log("error", "parseServerMessage", { error: String(error) });
			this.fail(error instanceof Error ? error : new Error(String(error)));
			return false;
		}
		const update =
			serverMessage.message.case === "interactionUpdate" ? serverMessage.message.value.message?.case : undefined;
		// A heartbeat arrives every ten seconds whether or not the remote agent is working, so it
		// proves the connection and never counts as progress.
		if (update !== "heartbeat") this.#liveness?.markProgress();
		this.#dispatch(serverMessage);
		if (update === "turnEnded") this.#endTurn();
		return true;
	}

	#dispatch(serverMessage: AgentServerMessage): void {
		const run = this.#run;
		const handled = handleServerMessage(
			serverMessage,
			run.output,
			run.stream,
			run.state,
			run.blobStore,
			run.h2Request,
			run.options?.execHandlers,
			run.options?.onToolResult,
			run.requestContextTools,
			this.#onCheckpoint,
			this.#delivery,
		);
		this.#pendingMessages.add(handled);
		handled
			.catch(error => {
				// `log` writes nothing unless DEBUG_CURSOR is set, so a failure inside a handler (an
				// exec handler that threw, a malformed interaction update, a checkpoint that could not
				// be applied) is reported here and fails the turn at once.
				logger.warn("Cursor server message handler failed", {
					model: run.model.id,
					messageCase: serverMessage.message.case,
					error: errorMessage(error),
				});
				this.fail(error instanceof Error ? error : new Error(String(error)));
			})
			.finally(() => {
				this.#pendingMessages.delete(handled);
			});
	}

	/**
	 * Declares the turn over. In-flight message handlers settle first, so a `turnEnded` that arrives
	 * while an exec handler is pending cannot report success early or orphan the handler, and protocol
	 * events that already arrived (HTTP/2 trailers) get one event-loop turn to record a failure.
	 */
	#endTurn(): void {
		this.#turnCompleted = true;
		void Promise.allSettled(Array.from(this.#pendingMessages)).then(async () => {
			await yieldToProtocolEvents();
			this.#terminate();
		});
	}

	#terminate(): void {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#settle().catch(error => this.#outcome.reject(error));
	}

	async #settle(): Promise<void> {
		// A completed turn waits for every handler so `turnEnded` cannot outrun an exec reply. A failed
		// turn does not: the failure is the result, and a wedged handler must not keep it unreported.
		if (this.#pendingMessages.size > 0) {
			await Promise.race([Promise.allSettled(Array.from(this.#pendingMessages)), this.#failed.promise]);
		}
		await this.#closeDebugLog();
		if (this.#refusedStatus !== undefined) {
			// The status is the remedy: 401 is a credential, 429 is a wait, 404 is the route.
			this.#outcome.reject(
				new AIError.CursorApiError(
					`Cursor API error ${this.#refusedStatus}: ${AIError.boundProviderErrorDetail(this.#refusalBody)}`,
					this.#refusedStatus,
				),
			);
		} else if (this.#failure) {
			this.#outcome.reject(this.#failure);
		} else if (this.#turnCompleted) {
			this.#outcome.resolve();
		} else {
			// A dropped connection that closes cleanly ends the stream with a half-written reply, which
			// must not be persisted as a finished turn.
			this.#outcome.reject(
				new AIError.ProviderResponseError(
					"Cursor stream ended without a turn_ended update (connection dropped or response truncated)",
					{ provider: this.#run.model.provider, kind: "incomplete-stream" },
				),
			);
		}
	}

	async #closeDebugLog(): Promise<void> {
		try {
			const log = await this.#debugResponseLog;
			await log?.close();
		} catch {
			// Ignore debug log close failure so logging never masks the turn result
		}
	}
}

/** One `streamCursor` call: the request it builds, the stream that answers it, and the events it reports. */
class CursorTurn {
	readonly #model: Model<"cursor-agent">;
	readonly #context: Context;
	readonly #options: CursorOptions | undefined;
	readonly #stream: AssistantMessageEventStream;
	readonly #startTime = performance.now();
	readonly #output: AssistantMessage;
	readonly #state: BlockState;
	#h2Client: http2.ClientHttp2Session | undefined;
	#h2Request: http2.ClientHttp2Stream | undefined;
	#run: CursorRunStream | undefined;

	constructor(
		model: Model<"cursor-agent">,
		context: Context,
		options: CursorOptions | undefined,
		stream: AssistantMessageEventStream,
	) {
		this.#model = model;
		this.#context = context;
		this.#options = options;
		this.#stream = stream;
		this.#output = createInitialResponsesAssistantMessage("cursor-agent" as Api, model.provider, model.id);
		this.#state = createBlockState(createCursorUsageAccount(model, this.#output));
	}

	async run(): Promise<void> {
		try {
			await this.#exchange();
			this.#complete();
		} catch (error) {
			await this.#fail(error);
		} finally {
			await this.#release();
		}
	}

	async #exchange(): Promise<void> {
		const model = this.#model;
		const options = this.#options;
		if (options?.signal?.aborted) throw new AIError.RequestAbortError();
		const apiKey = options?.apiKey;
		if (!apiKey) throw new AIError.MissingApiKeyError(undefined, "Cursor API key (access token) is required");
		const conversationId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
		const blobStore = conversationBlobStores.get(conversationId) ?? new Map<string, Uint8Array>();
		conversationBlobStores.set(conversationId, blobStore);
		// The request's own state is not cached: its history fields are rebuilt from the context on
		// every turn, and every other field is the cached checkpoint it was built from, or fresh.
		const { requestBytes, systemPromptBlobIds } = await buildGrpcRequest(model, this.#context, options, {
			conversationId,
			blobStore,
			conversationState: conversationStateCache.get(conversationId),
		});
		const requestContextTools = buildMcpToolDefinitions(this.#context.tools);

		const baseUrl = model.baseUrl || CURSOR_API_URL;
		const requestHeaders = {
			":method": "POST",
			":path": CURSOR_RUN_PATH,
			"content-type": "application/connect+proto",
			"connect-protocol-version": "1",
			te: "trailers",
			authorization: `Bearer ${apiKey}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": CURSOR_CLIENT_VERSION,
			"x-cursor-client-type": "cli",
			"x-request-id": crypto.randomUUID(),
		};
		const debugSession = isRequestDebugEnabled()
			? await createRequestDebugSession({
					protocol: "http2",
					method: "POST",
					url: new URL(CURSOR_RUN_PATH, baseUrl).toString(),
					headers: requestHeaders,
					bodyBase64: Buffer.from(requestBytes).toString("base64"),
				})
			: undefined;

		const proxyUrl = shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(model.provider);
		const tlsSocket = proxyUrl
			? await connectProxiedSocket(proxyUrl, baseUrl, {
					signal: options?.signal,
					timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
				})
			: undefined;
		const h2Client = tlsSocket
			? http2.connect(baseUrl, { createConnection: () => tlsSocket })
			: http2.connect(baseUrl);
		this.#h2Client = h2Client;
		const h2Request = h2Client.request(requestHeaders);
		this.#h2Request = h2Request;
		this.#stream.push({ type: "start", partial: this.#output });

		const run = new CursorRunStream({
			model,
			options,
			stream: this.#stream,
			output: this.#output,
			state: this.#state,
			h2Client,
			h2Request,
			debugSession,
			conversationId,
			blobStore,
			systemPromptBlobIds,
			requestContextTools,
		});
		this.#run = run;
		run.start(requestBytes);
		await run.settled;
	}

	#complete(): void {
		const output = this.#output;
		const stream = this.#stream;
		const state = this.#state;
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		// Every call the turn opened and never completed, not only the last one: a batch completes
		// out of pointer order, and a call left without a `toolcall_end` reads as one that never
		// finished streaming.
		for (const open of openToolCallBlocks(output)) {
			const partial = open[kStreamingPartialJson];
			if (partial) open.arguments = parseStreamingJson(partial);
			clearStreamingPartialJson(open);
			stream.push({
				type: "toolcall_end",
				contentIndex: output.content.indexOf(open),
				toolCall: open,
				partial: output,
			});
		}
		state.setToolCall(null);
		this.#stamp();
		stream.push({
			type: "done",
			reason: output.stopReason as "stop" | "length" | "toolUse",
			message: output,
		});
		stream.end();
	}

	async #fail(error: unknown): Promise<void> {
		const result = await AIError.finalize(error, { api: this.#model.api, signal: this.#options?.signal });
		AIError.applyFinalizeResult(this.#output, result);
		this.#stamp();
		this.#stream.push({ type: "error", reason: this.#output.stopReason, error: this.#output });
		this.#stream.end();
	}

	#stamp(): void {
		this.#output.duration = performance.now() - this.#startTime;
		const firstTokenTime = this.#state.firstTokenTime;
		if (firstTokenTime) this.#output.ttft = firstTokenTime - this.#startTime;
	}

	async #release(): Promise<void> {
		await this.#run?.release();
		try {
			this.#h2Request?.close();
		} catch {
			// Ignore close errors
		}
		try {
			this.#h2Client?.close();
		} catch {
			// Ignore close errors
		}
	}
}

export const streamCursor: StreamFunction<"cursor-agent"> = (
	model: Model<"cursor-agent">,
	context: Context,
	options?: CursorOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void new CursorTurn(model, context, options, stream).run();
	return stream;
};

/**
 * The `call_id` every tool-call update carries, kept on the block it opened.
 *
 * A block's `id` comes from the MCP payload's `tool_call_id`, which is the id
 * the exec channel and the `toolResult` also use. `ToolCallDeltaUpdate`,
 * `PartialToolCallUpdate` and `ToolCallCompletedUpdate` address a call by
 * `call_id` instead. Cursor sends the same string in both fields today, so
 * recording it costs nothing and keeps routing correct if it ever stops.
 */
const kCursorWireCallId = Symbol("provider.block.cursorWireCallId");

/**
 * Set while a block's argument buffer holds the started frame's own argument
 * map rather than text streamed by `args_text_delta`.
 */
const kCursorSeededArgs = Symbol("provider.block.cursorSeededArgs");

/**
 * Every tool-call block this turn opened and never closed.
 *
 * A closed block has had its argument buffer cleared, so the marker's presence
 * is the open/closed answer and no separate bookkeeping can disagree with the
 * blocks themselves. Exec-synthesized blocks open and close in one step and
 * never carry the marker.
 */
function openToolCallBlocks(output: AssistantMessage): ToolCallState[] {
	const open: ToolCallState[] = [];
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		const candidate = block as ToolCallState;
		if (candidate[kStreamingPartialJson] !== undefined) open.push(candidate);
	}
	return open;
}

export type ToolCallState = ToolCall & {
	[kStreamingBlockIndex]: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingBlockKind]: "mcp" | "todo" | "cursor-exec";
	[kCursorExecResolved]?: true;
	[kCursorWireCallId]?: string;
	[kCursorSeededArgs]?: boolean;
};

/**
 * Every token number Cursor puts on the wire, and the only place any of them
 * becomes `usage`.
 *
 * Cursor reports two quantities and neither one is a usage object.
 * `TokenDeltaUpdate.tokens` is an increment of THIS turn's completion.
 * `ConversationTokenDetails` is a gauge of the WHOLE conversation against the
 * model's window: `used_tokens` counts the system prompt, the tool schemas, the
 * rules, the skills, the agent definitions and the conversation, and it is
 * sampled after this turn's reply was appended, so it already contains the
 * completion. Nothing on the wire reports a prompt-cache breakdown, which is
 * why `cacheRead` and `cacheWrite` stay zero: Cursor does not say.
 *
 * Three shipped defects came from folding those two quantities into `usage`
 * where each one happened to arrive. They are accumulated raw here instead, and
 * turned into a usage object by {@link CursorUsageAccount.fold} alone.
 */
export interface CursorUsageAccount {
	/** Running sum of `TokenDeltaUpdate.tokens`: this turn's completion. */
	completionTokens: number;
	/** Latest populated `ConversationTokenDetails.used_tokens`. */
	conversationTokens: number;
	/** Latest populated `ConversationTokenDetails.max_tokens`. */
	contextWindow: number;
	/**
	 * Latest populated `ConversationTokenDetails.detailed.entry`, mapped to the
	 * provider-neutral shape. Undefined until a checkpoint carries one.
	 */
	contextComposition: ProviderContextBucket[] | undefined;
	/** Recompute the message's usage, cost and reported window from the above. */
	fold: () => void;
}

/** The turn's token account, bound to the message it reports into. */
export function createCursorUsageAccount(model: Model<"cursor-agent">, output: AssistantMessage): CursorUsageAccount {
	const account: CursorUsageAccount = {
		completionTokens: 0,
		conversationTokens: 0,
		contextWindow: 0,
		contextComposition: undefined,
		fold: () => {
			output.usage.output = account.completionTokens;
			// The conversation gauge is sampled with this turn's reply already in
			// it, so the prompt side is whatever is left once the completion comes
			// out. Reporting the gauge as `input` and then adding the completion on
			// top counted the reply twice, which is how a 98k-token turn spent 38%
			// of a 256k window on tokens that were never there.
			output.usage.input = Math.max(0, account.conversationTokens - account.completionTokens);
			output.usage.totalTokens = output.usage.input + output.usage.output;
			// A window the provider states beats a catalog default, which is a guess
			// for every model the catalog predates. Only a populated gauge carries
			// one: most checkpoints report an empty `token_details`.
			if (account.contextWindow > 0) {
				output.providerContextWindow = account.contextWindow;
			}
			// No guard, unlike the window above: `contextWindow: 0` is a sentinel
			// that would be a wrong answer if written, where an undefined
			// composition is exactly the right answer for a turn Cursor never
			// described. The account is the one thing that refuses to forget a
			// reading, and keeping that rule in one place is the point of the type.
			output.providerContextComposition = account.contextComposition;
			// Folded here rather than once at the end of a clean turn, so an aborted
			// or failed turn still reports what it spent.
			calculateCost(model, output.usage);
		},
	};
	return account;
}

export interface BlockState {
	currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null;
	currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null;
	currentToolCall: ToolCallState | null;
	/**
	 * Every tool call the exec channel has dispatched this turn, keyed by tool-call id, and the
	 * reply its one run produced.
	 *
	 * Two readers. Cursor surfaces an MCP call on two channels at once: `mcpArgs` on the exec
	 * channel, which this provider runs through the caller's handler and answers, and an
	 * `mcpToolCall` block on the assistant stream. The two arrive in either order, so a block
	 * that opens after its dispatch reads this map to know the call already ran.
	 *
	 * And Cursor re-sends an exec request for a call it already dispatched. The repeat is
	 * answered from the entry here, see {@link dispatchExecOnce}.
	 */
	execDispatches: Map<string, Promise<ExecReply>>;
	firstTokenTime: number | undefined;
	/** This turn's token account. See {@link CursorUsageAccount}. */
	usage: CursorUsageAccount;
	setTextBlock: (b: (TextContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setThinkingBlock: (b: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setToolCall: (t: ToolCallState | null) => void;
	setFirstTokenTime: () => void;
}

/** Exported for tests: drives one Cursor server message through the stream (exec waits mark the stream busy). */
export async function handleServerMessage(
	msg: AgentServerMessage,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	requestContextTools: McpToolDefinition[],
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
	delivery?: CursorTurnDelivery,
): Promise<void> {
	const msgCase = msg.message.case;

	log("serverMessage", msgCase, msg.message.value);

	if (msgCase === "interactionUpdate") {
		// InteractionUpdateView is a structural subset of the generated type; the
		// weak-type rule (all-optional view vs. field-less updates like
		// thinkingCompleted) blocks direct assignability, hence the assertion.
		processInteractionUpdate(msg.message.value as InteractionUpdateView, output, stream, state);
	} else if (msgCase === "kvServerMessage") {
		handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request, delivery);
	} else if (msgCase === "execServerMessage") {
		// The server is waiting on OUR local tool result during this window — no
		// AssistantMessageEvent flows until the handler finishes. Mark the wait
		// as local work so the lazy stream idle watchdog attributes the silence
		// to the tool run instead of aborting a healthy stream (issue #4593).
		await stream.trackLocalWork(
			handleExecServerMessage(
				msg.message.value as ExecServerMessage,
				h2Request,
				execHandlers,
				onToolResult,
				requestContextTools,
				output,
				stream,
				state,
			),
		);
	} else if (msgCase === "conversationCheckpointUpdate") {
		handleConversationCheckpointUpdate(msg.message.value, state.usage, onConversationCheckpoint);
	}
}

/**
 * Turn-scoped hooks the message handlers need beyond the blob store itself.
 *
 * `systemPromptBlobIds` is the set of hex ids `buildGrpcRequest` minted for this request's system
 * prompt entries. The kv channel only ever sees an opaque id, so without it a miss on the system
 * prompt and a miss on some historical turn are the same event, and they are not: one is a
 * degraded transcript, the other is a model running with no instructions at all.
 *
 * The rules payload the `requestContext` frame carries is empty by construction — the operator's
 * instructions ride the active user turn — so that frame reports nothing back to the turn.
 */
interface CursorTurnDelivery {
	systemPromptBlobIds: ReadonlySet<string>;
	/** Fails the turn through {@link CursorRunStream.fail}, the channel a Connect end-stream error uses. */
	onFatal: (error: Error) => void;
}

function handleKvServerMessage(
	kvMsg: KvServerMessage,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
	lookup?: CursorTurnDelivery,
): void {
	const kvCase = kvMsg.message.case;

	if (kvCase === "getBlobArgs") {
		const blobId = kvMsg.message.value.blobId;
		const blobIdKey = Buffer.from(blobId).toString("hex");

		const blobData = blobStore.get(blobIdKey);

		// A miss used to answer with an empty GetBlobResult and say nothing. That answer is
		// success-shaped on the wire (an 11-byte frame instead of one carrying the content), so the
		// server takes the blob to be empty and builds the prompt without it. `readCursorBlob` treats
		// the same fact as fatal (`Cursor blob not found`); this path failed open and silent for it.
		if (!blobData) {
			const isSystemPrompt = lookup?.systemPromptBlobIds.has(blobIdKey) === true;
			logger.warn(
				isSystemPrompt
					? "Cursor asked for a system-prompt blob this process does not hold; the model would have run with no system prompt"
					: "Cursor asked for a blob this process does not hold; that part of the conversation is missing from the prompt",
				{ blobId: blobIdKey, systemPrompt: isSystemPrompt, knownBlobs: blobStore.size },
			);
			// A missing history entry degrades the transcript and the turn is still worth having. A
			// missing SYSTEM PROMPT is not degradation: the model answers plausibly with none of the
			// operator's instructions and nothing else in the run would ever say so.
			if (isSystemPrompt) {
				lookup?.onFatal(
					new AIError.ProviderResponseError(
						`Cursor requested system-prompt blob ${blobIdKey} which this process does not hold, so the request would have run with no system prompt`,
						{ provider: "cursor", kind: "runtime" },
					),
				);
			}
		}

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "getBlobResult",
				value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		h2Request.write(frameConnectMessage(responseBytes));

		log("kvClient", "getBlobResult", { blobId: blobIdKey.slice(0, 40), hit: blobData !== undefined });
	} else if (kvCase === "setBlobArgs") {
		const { blobId, blobData } = kvMsg.message.value;
		const blobIdKey = Buffer.from(blobId).toString("hex");
		blobStore.set(blobIdKey, blobData);

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "setBlobResult",
				value: create(SetBlobResultSchema, {}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		h2Request.write(frameConnectMessage(responseBytes));

		log("kvClient", "setBlobResult", { blobId: blobIdKey.slice(0, 40) });
	}
}

function sendShellStreamEvent(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	event: ShellStream["event"],
): void {
	sendExecReply(h2Request, execMsg, { case: "shellStream", value: create(ShellStreamSchema, { event }) });
}

function sanitizeShellExecResult(execResult: ShellResult): ShellResult {
	const result = execResult.result;
	if (!result) return execResult;

	switch (result.case) {
		case "success":
		case "failure": {
			const value = result.value;
			return {
				...execResult,
				result: {
					case: result.case,
					value: {
						...value,
						stdout: value.stdout ? sanitizeText(value.stdout) : value.stdout,
						stderr: value.stderr ? sanitizeText(value.stderr) : value.stderr,
					},
				},
			} as ShellResult;
		}
		default:
			return execResult;
	}
}

/** A trailing escape prefix that a later chunk may complete. */
const INCOMPLETE_ESCAPE = /\x1b(|\[|\[\d*|\[\?|\[\?\d*|\]\d*;?)$/;

/**
 * One shell output stream (stdout or stderr) buffered for the exec stream: held text is sent on a
 * newline, past 4 KiB, or 100 ms after it arrived, minus an incomplete ANSI escape at the tail,
 * which waits for its rest.
 */
class ShellOutputChannel {
	#buffer = "";
	#timer: NodeJS.Timeout | null = null;
	readonly #send: (data: string) => void;

	constructor(send: (data: string) => void) {
		this.#send = send;
	}

	push(data: string): void {
		this.#buffer += data;
		if (this.#buffer.includes("\n") || this.#buffer.length > 4096) {
			this.#cancelTimer();
			this.flush();
		} else if (!this.#timer) {
			this.#timer = setTimeout(() => {
				this.#timer = null;
				this.flush();
			}, 100);
		}
	}

	/** Drop the pending timer and send everything held, before the exit event. */
	close(): void {
		this.#cancelTimer();
		this.flush();
	}

	flush(): void {
		if (!this.#buffer) return;
		let safeEnd = this.#buffer.length;
		const match = this.#buffer.match(INCOMPLETE_ESCAPE);
		if (match && match[0].length > 0) safeEnd -= match[0].length;
		const toSend = this.#buffer.slice(0, safeEnd);
		const remaining = this.#buffer.slice(safeEnd);
		if (toSend) this.#send(sanitizeText(toSend));
		this.#buffer = remaining;
	}

	#cancelTimer(): void {
		if (!this.#timer) return;
		clearTimeout(this.#timer);
		this.#timer = null;
	}
}

async function handleShellStreamArgs(
	args: ShellArgs,
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<ExecReply> {
	const normalizedWorkingDirectory = args.workingDirectory || process.cwd();
	const normalizedArgs: ShellArgs = { ...args, workingDirectory: normalizedWorkingDirectory };
	const startTs = performance.now();
	log("shellStream", "start", {
		command: args.command,
		workingDirectory: normalizedWorkingDirectory,
		execId: execMsg.execId,
		hasExecHandlers: !!execHandlers,
		hasShell: !!execHandlers?.shell,
		hasShellStream: !!execHandlers?.shellStream,
	});

	sendShellStreamEvent(h2Request, execMsg, { case: "start", value: create(ShellStreamStartSchema, {}) });

	const stdout = new ShellOutputChannel(data => {
		sendShellStreamEvent(h2Request, execMsg, { case: "stdout", value: create(ShellStreamStdoutSchema, { data }) });
	});
	const stderr = new ShellOutputChannel(data => {
		sendShellStreamEvent(h2Request, execMsg, { case: "stderr", value: create(ShellStreamStderrSchema, { data }) });
	});
	const streamCallbacks: CursorShellStreamCallbacks = {
		onStdout: data => stdout.push(data),
		onStderr: data => stderr.push(data),
	};

	// Prefer the streaming handler — it forwards output chunks in real time.
	// Falls back to the batch shell handler otherwise.
	const streamHandler = execHandlers?.shellStream?.bind(execHandlers);
	const batchHandler = execHandlers?.shell?.bind(execHandlers);
	const handler = streamHandler ? (shellArgs: ShellArgs) => streamHandler(shellArgs, streamCallbacks) : batchHandler;

	const { execResult } = await resolveExecHandler(
		args,
		handler as typeof batchHandler,
		onToolResult,
		toolResult => buildShellResultFromToolResult(normalizedArgs, toolResult),
		reason => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
		error => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
	);

	// When using the batch handler (no shellStream), send buffered stdout/stderr
	// after execution completes. With shellStream these were already sent in real time.
	const sendBufferedOutput = !streamHandler;
	const sanitizedExecResult = sanitizeShellExecResult(execResult);

	// Flush any remaining buffered output before sending results
	stdout.close();
	stderr.close();

	sendShellStreamExitFromResult(h2Request, execMsg, sanitizedExecResult, sendBufferedOutput);
	// Cursor can keep the turn pending when it receives only stream deltas.
	// Send the final structured shellResult as completion acknowledgement.
	const reply = sendExecReply(h2Request, execMsg, { case: "shellResult", value: sanitizedExecResult });
	sendExecClientStreamClose(h2Request, execMsg);

	log("shellStream", "done", { elapsed: performance.now() - startTs });
	return reply;
}

function sendShellStreamExitFromResult(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	execResult: ShellResult,
	sendBufferedOutput: boolean,
): void {
	const result = execResult.result;
	switch (result.case) {
		case "success": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeText(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeText(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "failure": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeText(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeText(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: value.aborted,
					abortReason: value.abortReason,
				}),
			});
			return;
		}
		case "rejected": {
			sendShellStreamEvent(h2Request, execMsg, { case: "rejected", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "timeout": {
			const value = result.value;
			sendShellStreamEvent(h2Request, execMsg, {
				case: "stderr",
				value: create(ShellStreamStderrSchema, {
					data: `Command timed out after ${value.timeoutMs}ms`,
				}),
			});
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: value.workingDirectory,
					aborted: true,
				}),
			});
			return;
		}
		case "permissionDenied": {
			sendShellStreamEvent(h2Request, execMsg, { case: "permissionDenied", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		default:
			return;
	}
}

async function handleExecServerMessage(
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	requestContextTools: McpToolDefinition[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): Promise<void> {
	const execCase = execMsg.message.case;
	log("exec", "dispatch", { execCase, execId: execMsg.execId, hasHandlers: !!execHandlers });
	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, {
			// EMPTY, DELIBERATELY, and it must stay empty. The server applies no rule this
			// client sends: a capture that replaced the whole payload with a single rule
			// reading "every reply must be exactly RULE-OK" changed nothing about the answer.
			// Filling it again would upload the assembled prompt a SECOND time — tens of
			// kilobytes per turn — to a channel that discards it, while the copy that reaches
			// the model rides on the active user turn (see buildGrpcRequest).
			rules: [],
			repositoryInfo: [],
			tools: requestContextTools,
			gitRepos: [],
			projectLayouts: [],
			mcpInstructions: [],
			fileContents: {},
			customSubagents: [],
		});

		const requestContextResult = create(RequestContextResultSchema, {
			result: {
				case: "success",
				value: create(RequestContextSuccessSchema, { requestContext }),
			},
		});

		sendExecReply(h2Request, execMsg, { case: "requestContextResult", value: requestContextResult });
		log("execClient", "requestContextResult", { tools: requestContextTools.length });
		return;
	}

	if (!execCase) {
		return;
	}

	const run = () => runExecCall(execMsg, h2Request, execHandlers, onToolResult, output, stream, state);
	const toolCallId = execToolCallId(execMsg);
	if (toolCallId === undefined) {
		await run();
		return;
	}
	await dispatchExecOnce(toolCallId, execMsg, h2Request, state, run);
}

/**
 * The tool-call id of an exec request that runs a tool, or `undefined` for one that runs none.
 *
 * A request that arrives without an id is given a fresh one here, before anything reads it, so
 * the synthesized block, the tool result and the dispatch record all carry the same id.
 */
function execToolCallId(execMsg: ExecServerMessage): string | undefined {
	const message = execMsg.message;
	switch (message.case) {
		case "readArgs":
		case "lsArgs":
		case "grepArgs":
		case "writeArgs":
		case "deleteArgs":
		case "shellArgs":
		case "shellStreamArgs":
		case "diagnosticsArgs":
			if (!message.value.toolCallId) message.value.toolCallId = crypto.randomUUID();
			return message.value.toolCallId;
		case "mcpArgs":
			return message.value.toolCallId || undefined;
		default:
			return undefined;
	}
}

/**
 * Run one exec-channel tool call at most once per turn.
 *
 * WHY. Cursor re-sends an exec request for a call it already dispatched, under the same tool-call
 * id. Running it again executed the tool twice, which for `bash`, `write` and `delete` is a
 * second side effect, and synthesized a second block under the same id. The agent loop then
 * renamed that block `<id>_2`, nothing ever answered it, and the turn ended holding a call with no
 * result: recorded Cursor turns carried one such phantom for more than a third of their calls,
 * and each one blocked the session from continuing after the stream died.
 *
 * The repeat is answered with the first run's reply, awaited if that run is still going, so the
 * server receives an answer to every request it sent and the tool runs once.
 */
async function dispatchExecOnce(
	toolCallId: string,
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	state: BlockState,
	run: () => Promise<ExecReply>,
): Promise<void> {
	const first = state.execDispatches.get(toolCallId);
	if (first) {
		log("exec", "replay", { toolCallId, execId: execMsg.execId });
		replayExecReply(h2Request, execMsg, await first);
		return;
	}
	const { promise, resolve, reject } = Promise.withResolvers<ExecReply>();
	state.execDispatches.set(toolCallId, promise);
	run().then(resolve, reject);
	await promise;
}

/**
 * Answer a repeated exec request with the reply its first run sent.
 *
 * A shell call is framed by the repeat's own request: `shellStreamArgs` expects a stream that
 * opens, exits and closes, and `shellArgs` expects the bare `shellResult`, whichever of the two
 * the first request was.
 */
function replayExecReply(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage, reply: ExecReply): void {
	if (execMsg.message.case === "shellStreamArgs" && reply.case === "shellResult") {
		sendShellStreamEvent(h2Request, execMsg, { case: "start", value: create(ShellStreamStartSchema, {}) });
		sendShellStreamExitFromResult(h2Request, execMsg, reply.value, true);
		sendExecReply(h2Request, execMsg, reply);
		sendExecClientStreamClose(h2Request, execMsg);
		return;
	}
	sendExecReply(h2Request, execMsg, reply);
}

/** Run one exec request and answer it, returning the answer for {@link dispatchExecOnce}. */
async function runExecCall(
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): Promise<ExecReply> {
	switch (execMsg.message.case) {
		case "readArgs": {
			const args = execMsg.message.value;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.read?.bind(execHandlers),
				onToolResult,
				toolResult => buildReadResultFromToolResult(args.path, toolResult),
				reason => buildReadRejectedResult(args.path, reason),
				error => buildReadErrorResult(args.path, error),
			);
			return sendExecReply(h2Request, execMsg, { case: "readResult", value: execResult });
		}
		case "lsArgs": {
			const args = execMsg.message.value;
			// Bridge maps `ls` onto the coding-agent `read` tool (see
			// `CursorExecHandlers.ls` in `pi-coding-agent/src/cursor.ts`); mirror
			// that here so the synthesized block matches the toolResult's `toolName`.
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.ls?.bind(execHandlers),
				onToolResult,
				toolResult => buildLsResultFromToolResult(args.path, toolResult),
				reason => buildLsRejectedResult(args.path, reason),
				error => buildLsErrorResult(args.path, error),
			);
			return sendExecReply(h2Request, execMsg, { case: "lsResult", value: execResult });
		}
		case "grepArgs": {
			const args = execMsg.message.value;
			// Cursor's model sometimes emits `grepArgs` with an empty `pattern` and a
			// non-empty `glob`, expecting grep to list files matching the glob. Reject
			// that up front with an actionable error so the model retries with a real
			// regex or switches to `ls`/`read`, instead of the local grep tool
			// surfacing a bare "Pattern must not be empty" (issue #4574) after the
			// synthesized block has already been persisted with a placeholder pattern.
			const emptyPatternError = emptyGrepPatternRejection(args.pattern, args.glob);
			if (emptyPatternError !== null) {
				return sendExecReply(h2Request, execMsg, {
					case: "grepResult",
					value: buildGrepErrorResult(emptyPatternError),
				});
			}
			// Mirror the coding-agent bridge's arg mapping so live UI (from
			// `tool_execution_start`) and rebuilt transcript (from this block)
			// display identical args.
			const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "grep", {
				pattern: args.pattern,
				path: searchPath,
				case: args.caseInsensitive === true ? false : undefined,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.grep?.bind(execHandlers),
				onToolResult,
				toolResult => buildGrepResultFromToolResult(args, toolResult),
				reason => buildGrepErrorResult(reason),
				error => buildGrepErrorResult(error),
			);
			return sendExecReply(h2Request, execMsg, { case: "grepResult", value: execResult });
		}
		case "writeArgs": {
			const args = execMsg.message.value;
			// Match the bridge: prefer `fileText`, fall back to decoded `fileBytes`.
			const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "write", {
				path: args.path,
				content,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.write?.bind(execHandlers),
				onToolResult,
				toolResult =>
					buildWriteResultFromToolResult(
						{
							path: args.path,
							fileText: args.fileText,
							fileBytes: args.fileBytes,
							returnFileContentAfterWrite: args.returnFileContentAfterWrite,
						},
						toolResult,
					),
				reason => buildWriteRejectedResult(args.path, reason),
				error => buildWriteErrorResult(args.path, error),
			);
			return sendExecReply(h2Request, execMsg, { case: "writeResult", value: execResult });
		}
		case "deleteArgs": {
			const args = execMsg.message.value;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "delete", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.delete?.bind(execHandlers),
				onToolResult,
				toolResult => buildDeleteResultFromToolResult(args.path, toolResult),
				reason => buildDeleteRejectedResult(args.path, reason),
				error => buildDeleteErrorResult(args.path, error),
			);
			return sendExecReply(h2Request, execMsg, { case: "deleteResult", value: execResult });
		}
		case "shellArgs": {
			const args = execMsg.message.value;
			const normalizedArgs: ShellArgs = { ...args, workingDirectory: args.workingDirectory || process.cwd() };
			// Match the bridge (`CursorExecHandlers.shell`): map `workingDirectory`
			// → `cwd`, drop non-positive timeouts.
			const shellTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: shellTimeout,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.shell?.bind(execHandlers),
				onToolResult,
				toolResult => buildShellResultFromToolResult(normalizedArgs, toolResult),
				reason => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
				error => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
			);
			const sanitizedExecResult = sanitizeShellExecResult(execResult);
			return sendExecReply(h2Request, execMsg, { case: "shellResult", value: sanitizedExecResult });
		}
		case "shellStreamArgs": {
			const args = execMsg.message.value;
			const shellStreamTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: shellStreamTimeout,
			});
			return handleShellStreamArgs(args, execMsg, h2Request, execHandlers, onToolResult);
		}
		case "backgroundShellSpawnArgs": {
			const args = execMsg.message.value;
			const execResult = create(BackgroundShellSpawnResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command,
						workingDirectory: args.workingDirectory,
						reason: "Not implemented",
						isReadonly: false,
					}),
				},
			});
			return sendExecReply(h2Request, execMsg, { case: "backgroundShellSpawnResult", value: execResult });
		}
		case "writeShellStdinArgs": {
			const execResult = create(WriteShellStdinResultSchema, {
				result: {
					case: "error",
					value: create(WriteShellStdinErrorSchema, {
						error: "Not implemented",
					}),
				},
			});
			return sendExecReply(h2Request, execMsg, { case: "writeShellStdinResult", value: execResult });
		}
		case "fetchArgs": {
			const args = execMsg.message.value;
			const execResult = create(FetchResultSchema, {
				result: {
					case: "error",
					value: create(FetchErrorSchema, {
						url: args.url,
						error: "Not implemented",
					}),
				},
			});
			return sendExecReply(h2Request, execMsg, { case: "fetchResult", value: execResult });
		}
		case "diagnosticsArgs": {
			const args = execMsg.message.value;
			// Bridge maps `diagnostics` onto the coding-agent `lsp` tool with
			// `action: "diagnostics"` and `file: path`.
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "lsp", {
				action: "diagnostics",
				file: args.path,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.diagnostics?.bind(execHandlers),
				onToolResult,
				toolResult => buildDiagnosticsResultFromToolResult(args.path, toolResult),
				reason => buildDiagnosticsRejectedResult(args.path, reason),
				error => buildDiagnosticsErrorResult(args.path, error),
			);
			return sendExecReply(h2Request, execMsg, { case: "diagnosticsResult", value: execResult });
		}
		case "mcpArgs": {
			const args = execMsg.message.value;
			const mcpCall = decodeMcpCall(args);
			// This call is about to run HERE, through the caller's handler, and its
			// result goes back on the exec channel. The same call also reaches the
			// assistant stream as an `mcpToolCall` block, and an unmarked block is
			// runnable, so `agent-loop.ts` executed every one of these a second time
			// after the turn closed — a duplicate side effect when the arguments had
			// streamed, and a validation failure against `{}` when they had not,
			// either way a second `toolResult` under an id that already had one.
			// Cursor's own exec tools never had this problem because
			// `synthesizeCursorExecToolCall` builds their block already stamped.
			markCursorExecDispatched(mcpCall.toolCallId, output);
			const { execResult } = await resolveExecHandler(
				mcpCall,
				execHandlers?.mcp?.bind(execHandlers),
				onToolResult,
				toolResult => buildMcpResultFromToolResult(mcpCall, toolResult),
				_reason => buildMcpToolNotFoundResult(mcpCall),
				error => buildMcpErrorResult(error),
			);
			return sendExecReply(h2Request, execMsg, { case: "mcpResult", value: execResult });
		}
		case "listMcpResourcesExecArgs": {
			const execResult = create(ListMcpResourcesExecResultSchema, {});
			return sendExecReply(h2Request, execMsg, { case: "listMcpResourcesExecResult", value: execResult });
		}
		case "readMcpResourceExecArgs": {
			const execResult = create(ReadMcpResourceExecResultSchema, {});
			return sendExecReply(h2Request, execMsg, { case: "readMcpResourceExecResult", value: execResult });
		}
		case "recordScreenArgs": {
			const execResult = create(RecordScreenResultSchema, {});
			return sendExecReply(h2Request, execMsg, { case: "recordScreenResult", value: execResult });
		}
		case "computerUseArgs": {
			const execResult = create(ComputerUseResultSchema, {});
			return sendExecReply(h2Request, execMsg, { case: "computerUseResult", value: execResult });
		}
		default:
			log("warn", "unhandledExecMessage", { execCase: execMsg.message.case });
			// A bare ExecClientMessage (id + execId only, no typed result) so the
			// server gets an acknowledgement and doesn't hang waiting forever.
			return sendExecReply(h2Request, execMsg, { case: undefined });
	}
}

/** The answer one exec request received, kept so a repeat of it is answered without running it again. */
type ExecReply = ExecClientMessage["message"];

function sendExecReply(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage, reply: ExecReply): ExecReply {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execMsg.id,
		execId: execMsg.execId,
		message: reply,
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientMessage", value: execClientMessage },
	});

	const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
	h2Request.write(frameConnectMessage(responseBytes));

	log("execClientMessage", reply.case, reply.value);
	return reply;
}

function sendExecClientStreamClose(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage): void {
	const closeMessage = create(ExecClientControlMessageSchema, {
		message: {
			case: "streamClose",
			value: create(ExecClientStreamCloseSchema, {
				id: execMsg.id,
			}),
		},
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientControlMessage", value: closeMessage },
	});
	const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
	h2Request.write(frameConnectMessage(responseBytes));
	log("execClientControl", "streamClose", { id: execMsg.id, execId: execMsg.execId });
}

/** Exported for tests: verifies handler is invoked with correct `this` when passed as bound. */
export async function resolveExecHandler<TArgs, TResult>(
	args: TArgs,
	handler: ((args: TArgs) => Promise<CursorExecHandlerResult<TResult>>) | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	buildFromToolResult: (toolResult: ToolResultMessage) => TResult,
	buildRejected: (reason: string) => TResult,
	buildError: (error: string) => TResult,
): Promise<{ execResult: TResult; toolResult?: ToolResultMessage }> {
	if (!handler) {
		return { execResult: buildRejected("Tool not available") };
	}

	try {
		const handlerResult = await handler(args);
		const { execResult, toolResult } = splitExecHandlerResult(handlerResult);
		const finalToolResult = await applyToolResultHandler(toolResult, onToolResult);

		if (execResult) {
			return { execResult, toolResult: finalToolResult };
		}
		if (finalToolResult) {
			return { execResult: buildFromToolResult(finalToolResult), toolResult: finalToolResult };
		}
		return { execResult: buildRejected("Tool returned no result") };
	} catch (error) {
		const message = errorMessage(error);
		return { execResult: buildError(message) };
	}
}

function splitExecHandlerResult<TResult>(result: CursorExecHandlerResult<TResult>): {
	execResult?: TResult;
	toolResult?: ToolResultMessage;
} {
	if (isToolResultMessage(result)) {
		return { toolResult: result };
	}
	if (result && typeof result === "object") {
		const record = result as Record<string, unknown>;
		if ("execResult" in record) {
			const { execResult, toolResult } = record as {
				execResult: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("toolResult" in record && !isToolResultMessage(record)) {
			const { result: execResult, toolResult } = record as {
				result?: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("result" in record && !("$typeName" in record)) {
			const { result: execResult, toolResult } = record as {
				result: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
	}
	return { execResult: result as TResult };
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return !!value && typeof value === "object" && (value as ToolResultMessage).role === "toolResult";
}

async function applyToolResultHandler(
	toolResult: ToolResultMessage | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<ToolResultMessage | undefined> {
	if (!toolResult || !onToolResult) {
		return toolResult;
	}
	const updated = await onToolResult(toolResult);
	return updated ?? toolResult;
}

function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function toolResultWasTruncated(toolResult: ToolResultMessage): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const truncation = (toolResult.details as { truncation?: { truncated?: boolean } }).truncation;
	return !!truncation?.truncated;
}

function toolResultDetailBoolean(toolResult: ToolResultMessage, key: string): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const value = (toolResult.details as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : false;
}

function buildReadResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildReadErrorResult(path, text || "Read failed");
	}
	const totalLines = text ? text.split("\n").length : 0;
	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path,
				totalLines,
				fileSize: BigInt(Buffer.byteLength(text, "utf-8")),
				truncated: toolResultWasTruncated(toolResult),
				output: { case: "content", value: text },
			}),
		},
	});
}

function buildReadErrorResult(path: string, error: string) {
	return create(ReadResultSchema, {
		result: {
			case: "error",
			value: create(ReadErrorSchema, { path, error }),
		},
	});
}

function buildReadRejectedResult(path: string, reason: string) {
	return create(ReadResultSchema, {
		result: {
			case: "rejected",
			value: create(ReadRejectedSchema, { path, reason }),
		},
	});
}

function buildWriteResultFromToolResult(
	args: { path: string; fileText?: string; fileBytes?: Uint8Array; returnFileContentAfterWrite?: boolean },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildWriteErrorResult(args.path, text || "Write failed");
	}
	const fileText = args.fileText ?? "";
	const fileSize = args.fileBytes?.length ?? Buffer.byteLength(fileText, "utf-8");
	const linesCreated = fileText ? fileText.split("\n").length : 0;
	return create(WriteResultSchema, {
		result: {
			case: "success",
			value: create(WriteSuccessSchema, {
				path: args.path,
				linesCreated,
				fileSize,
				fileContentAfterWrite: args.returnFileContentAfterWrite ? fileText : undefined,
			}),
		},
	});
}

function buildWriteErrorResult(path: string, error: string) {
	return create(WriteResultSchema, {
		result: {
			case: "error",
			value: create(WriteErrorSchema, { path, error }),
		},
	});
}

function buildWriteRejectedResult(path: string, reason: string) {
	return create(WriteResultSchema, {
		result: {
			case: "rejected",
			value: create(WriteRejectedSchema, { path, reason }),
		},
	});
}

function buildDeleteResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDeleteErrorResult(path, text || "Delete failed");
	}
	return create(DeleteResultSchema, {
		result: {
			case: "success",
			value: create(DeleteSuccessSchema, {
				path,
				deletedFile: path,
				fileSize: BigInt(0),
				prevContent: "",
			}),
		},
	});
}

function buildDeleteErrorResult(path: string, error: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "error",
			value: create(DeleteErrorSchema, { path, error }),
		},
	});
}

function buildDeleteRejectedResult(path: string, reason: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "rejected",
			value: create(DeleteRejectedSchema, { path, reason }),
		},
	});
}

function buildShellResultFromToolResult(
	args: { command: string; workingDirectory: string },
	toolResult: ToolResultMessage,
) {
	const output = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildShellFailureResult(args.command, args.workingDirectory, output || "Shell failed");
	}
	return create(ShellResultSchema, {
		result: {
			case: "success",
			value: create(ShellSuccessSchema, {
				command: args.command,
				workingDirectory: args.workingDirectory,
				exitCode: 0,
				signal: "",
				stdout: output,
				stderr: "",
				executionTime: 0,
			}),
		},
	});
}

function buildShellFailureResult(command: string, workingDirectory: string, error: string) {
	return create(ShellResultSchema, {
		result: {
			case: "failure",
			value: create(ShellFailureSchema, {
				command,
				workingDirectory,
				exitCode: 1,
				signal: "",
				stdout: "",
				stderr: error,
				executionTime: 0,
				aborted: false,
			}),
		},
	});
}

function buildShellRejectedResult(command: string, workingDirectory: string, reason: string) {
	return create(ShellResultSchema, {
		result: {
			case: "rejected",
			value: create(ShellRejectedSchema, {
				command,
				workingDirectory,
				reason,
				isReadonly: false,
			}),
		},
	});
}

function buildLsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildLsErrorResult(path, text || "Ls failed");
	}
	const rootPath = path || ".";
	const entries = text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("["));
	const childrenDirs: LsDirectoryTreeNode[] = [];
	const childrenFiles: LsDirectoryTreeNode_File[] = [];

	for (const entry of entries) {
		const name = entry.split(" (")[0];
		if (name.endsWith("/")) {
			const dirName = name.slice(0, -1);
			childrenDirs.push(
				create(LsDirectoryTreeNodeSchema, {
					absPath: `${rootPath.replace(/\/$/, "")}/${dirName}`,
					childrenDirs: [],
					childrenFiles: [],
					childrenWereProcessed: false,
					fullSubtreeExtensionCounts: {},
					numFiles: 0,
				}),
			);
		} else {
			childrenFiles.push(create(LsDirectoryTreeNode_FileSchema, { name }));
		}
	}

	const root = create(LsDirectoryTreeNodeSchema, {
		absPath: rootPath,
		childrenDirs,
		childrenFiles,
		childrenWereProcessed: true,
		fullSubtreeExtensionCounts: {},
		numFiles: childrenFiles.length,
	});

	return create(LsResultSchema, {
		result: {
			case: "success",
			value: create(LsSuccessSchema, { directoryTreeRoot: root }),
		},
	});
}

function buildLsErrorResult(path: string, error: string) {
	return create(LsResultSchema, {
		result: {
			case: "error",
			value: create(LsErrorSchema, { path, error }),
		},
	});
}

function buildLsRejectedResult(path: string, reason: string) {
	return create(LsResultSchema, {
		result: {
			case: "rejected",
			value: create(LsRejectedSchema, { path, reason }),
		},
	});
}

export function buildGrepResultFromToolResult(
	args: { pattern: string; path?: string; outputMode?: string },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildGrepErrorResult(text || "Grep failed");
	}

	const outputMode = args.outputMode || "content";
	const clientTruncated = toolResultDetailBoolean(toolResult, "truncated");
	const lines = text
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));

	const workspaceKey = args.path || ".";
	let unionResult: GrepUnionResult;

	if (outputMode === "files_with_matches") {
		const files = lines;
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "files",
				value: create(GrepFilesResultSchema, {
					files,
					totalFiles: files.length,
					clientTruncated,
					ripgrepTruncated: false,
				}),
			},
		});
	} else if (outputMode === "count") {
		const counts = lines
			.map(line => {
				const separatorIndex = line.lastIndexOf(":");
				if (separatorIndex === -1) {
					return null;
				}
				const file = line.slice(0, separatorIndex);
				const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
				if (!file || !Number.isSafeInteger(count) || count < 0 || count > 0x7fffffff) {
					return null;
				}
				return create(GrepFileCountSchema, { file, count });
			})
			.filter((entry): entry is GrepFileCount => entry !== null);
		const totalMatches = counts.reduce((sum, entry) => sum + entry.count, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "count",
				value: create(GrepCountResultSchema, {
					counts,
					totalFiles: counts.length,
					totalMatches,
					clientTruncated,
					ripgrepTruncated: false,
				}),
			},
		});
	} else {
		const matchMap = new Map<string, Array<{ line: number; content: string; isContextLine: boolean }>>();
		let totalMatchedLines = 0;

		for (const line of lines) {
			const matchLine = line.match(/^(.+?):(\d+):\s?(.*)$/);
			const contextLine = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
			const match = matchLine ?? contextLine;
			if (!match) {
				continue;
			}
			const [, file, lineNumber, content] = match;
			const parsedLine = Number.parseInt(lineNumber, 10);
			if (!Number.isSafeInteger(parsedLine) || parsedLine < 1 || parsedLine > 0x7fffffff) {
				continue;
			}
			// A line is context only when it did NOT parse as a real match. The two
			// regexes overlap: a genuine match line whose content contains a
			// `-<digits>-` run (an ISO date like 2024-01-15, an index like x-1-y)
			// ALSO satisfies the context pattern, so `Boolean(contextLine)` would
			// mislabel that match as context and drop it from totalMatchedLines.
			// `match` already prefers matchLine, so derive the flag from matchLine.
			const isContextLine = matchLine === null;
			const list = matchMap.get(file) ?? [];
			list.push({ line: parsedLine, content, isContextLine });
			matchMap.set(file, list);
			if (!isContextLine) {
				totalMatchedLines += 1;
			}
		}

		const matches = Array.from(matchMap.entries()).map(([file, matches]) =>
			create(GrepFileMatchSchema, {
				file,
				matches: matches.map(entry =>
					create(GrepContentMatchSchema, {
						lineNumber: entry.line,
						content: entry.content,
						contentTruncated: false,
						isContextLine: entry.isContextLine,
					}),
				),
			}),
		);
		const totalLines = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "content",
				value: create(GrepContentResultSchema, {
					matches,
					totalLines,
					totalMatchedLines,
					clientTruncated,
					ripgrepTruncated: false,
				}),
			},
		});
	}

	return create(GrepResultSchema, {
		result: {
			case: "success",
			value: create(GrepSuccessSchema, {
				pattern: args.pattern,
				path: args.path || "",
				outputMode,
				workspaceResults: { [workspaceKey]: unionResult },
			}),
		},
	});
}

function buildGrepErrorResult(error: string) {
	return create(GrepResultSchema, {
		result: {
			case: "error",
			value: create(GrepErrorSchema, { error }),
		},
	});
}

/**
 * Reject a Cursor exec-channel `grepArgs` frame whose `pattern` is empty or
 * whitespace-only. Returns an actionable error message when the pattern is
 * unusable (with a `glob`-aware hint when the model likely meant to list
 * files), or `null` when the pattern is valid and grep should run.
 *
 * Exported for tests. Cursor's model sometimes sends `pattern=""` together
 * with a non-empty `glob`, expecting grep to enumerate matching files; the
 * downstream coding-agent `grep` tool rejects that with a bare "Pattern must
 * not be empty", which the TUI renders as `?` in the tool preview (issue
 * #4574). Handling it at the Cursor exec dispatch keeps the synthesized
 * `toolCall` block off the persisted assistant message and gives the model a
 * specific recovery hint.
 */
export function emptyGrepPatternRejection(pattern: string | undefined, glob: string | undefined): string | null {
	if (pattern && pattern.trim().length > 0) return null;
	if (glob && glob.length > 0) {
		return (
			`grep pattern is required (received an empty pattern). To list files matching "${glob}", ` +
			`pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.`
		);
	}
	return "grep pattern is required (received an empty pattern).";
}

function buildDiagnosticsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDiagnosticsErrorResult(path, text || "Diagnostics failed");
	}
	return create(DiagnosticsResultSchema, {
		result: {
			case: "success",
			value: create(DiagnosticsSuccessSchema, {
				path,
				diagnostics: [],
				totalDiagnostics: 0,
			}),
		},
	});
}

function buildDiagnosticsErrorResult(_path: string, error: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "error",
			value: create(DiagnosticsErrorSchema, { error }),
		},
	});
}

function buildDiagnosticsRejectedResult(path: string, reason: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "rejected",
			value: create(DiagnosticsRejectedSchema, { path, reason }),
		},
	});
}

function parseToolArgsJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		return text;
	}
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return text;
	}
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		const parsedValue = fromBinary(ValueSchema, value);
		const jsonValue = toJson(ValueSchema, parsedValue) as JsonValue;
		if (typeof jsonValue === "string") {
			return parseToolArgsJson(jsonValue);
		}
		return jsonValue;
	} catch {
		// Probing whether the bytes are a protobuf Value. Servers also send plain
		// text here, which is what the decode below handles.
	}
	const text = new TextDecoder().decode(value);
	return parseToolArgsJson(text);
}

/**
 * Stamp the assistant-stream block that names `toolCallId` so the agent loop
 * treats the call as already run.
 *
 * The wire fixes no order between the exec request and the `toolCallStarted`
 * update: a block that already exists is stamped now, and one that opens later
 * reads {@link BlockState.execDispatches}, which {@link dispatchExecOnce}
 * records before the call runs.
 */
function markCursorExecDispatched(toolCallId: string, output: AssistantMessage): void {
	if (!toolCallId) return;
	for (const block of output.content) {
		if (block.type === "toolCall" && block.id === toolCallId) {
			(block as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		}
	}
}

function decodeMcpArgsMap(args?: Record<string, Uint8Array>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		decoded[key] = decodeMcpArgValue(value);
	}
	return decoded;
}

function decodeMcpCall(args: {
	name: string;
	args: Record<string, Uint8Array>;
	toolCallId: string;
	providerIdentifier: string;
	toolName: string;
}): CursorMcpCall {
	const decodedArgs: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args.args ?? {})) {
		decodedArgs[key] = decodeMcpArgValue(value);
	}
	return {
		name: args.name,
		providerIdentifier: args.providerIdentifier,
		toolName: args.toolName || args.name,
		toolCallId: args.toolCallId,
		args: decodedArgs,
		rawArgs: args.args ?? {},
	};
}

function mapTodoStatusValue(status?: number): "pending" | "in_progress" | "completed" {
	switch (status) {
		case 2:
			return "in_progress";
		case 3:
			return "completed";
		default:
			return "pending";
	}
}

interface CursorTodoItem {
	id?: string;
	content?: string;
	status?: number;
}

interface CursorMcpArgsView {
	toolCallId?: string;
	name?: string;
	toolName?: string;
	args?: Record<string, Uint8Array>;
}

/** Oneof-shaped view of `agent.v1.ToolCall` limited to the cases this state
 *  machine consumes. `fromBinary` decodes oneofs as `{ case, value }` — flat
 *  `toolCall.mcpToolCall` property access never matches a decoded message. */
interface CursorToolCallView {
	tool?: { case?: string; value?: unknown };
}

function mcpToolCallOf(toolCall: CursorToolCallView): { args?: CursorMcpArgsView } | undefined {
	return toolCall.tool?.case === "mcpToolCall" ? (toolCall.tool.value as { args?: CursorMcpArgsView }) : undefined;
}

function buildTodoArgs(toolCall: CursorToolCallView): {
	todos: Array<{ id?: string; content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }>;
} | null {
	const todos =
		toolCall.tool?.case === "updateTodosToolCall"
			? (toolCall.tool.value as { args?: { todos?: CursorTodoItem[] } }).args?.todos
			: undefined;
	if (!todos) return null;
	return {
		todos: todos.map(todo => ({
			id: typeof todo.id === "string" && todo.id.length > 0 ? todo.id : undefined,
			content: typeof todo.content === "string" ? todo.content : "",
			activeForm: typeof todo.content === "string" ? todo.content : "",
			status: mapTodoStatusValue(typeof todo.status === "number" ? todo.status : undefined),
		})),
	};
}

function buildMcpResultFromToolResult(_mcpCall: CursorMcpCall, toolResult: ToolResultMessage) {
	if (toolResult.isError) {
		return buildMcpErrorResult(toolResultToText(toolResult) || "MCP tool failed");
	}
	const content = toolResult.content.map(item => {
		if (item.type === "image") {
			return create(McpToolResultContentItemSchema, {
				content: {
					case: "image",
					value: create(McpImageContentSchema, {
						data: Uint8Array.from(Buffer.from(item.data, "base64")),
						mimeType: item.mimeType,
					}),
				},
			});
		}
		return create(McpToolResultContentItemSchema, {
			content: {
				case: "text",
				value: create(McpTextContentSchema, { text: item.text }),
			},
		});
	});

	return create(McpResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content,
				isError: false,
			}),
		},
	});
}

function buildMcpToolNotFoundResult(mcpCall: CursorMcpCall) {
	return create(McpResultSchema, {
		result: {
			case: "toolNotFound",
			value: create(McpToolNotFoundSchema, { name: mcpCall.toolName, availableTools: [] }),
		},
	});
}

function buildMcpErrorResult(error: string) {
	return create(McpResultSchema, {
		result: {
			case: "error",
			value: create(McpErrorSchema, { error }),
		},
	});
}

/**
 * Merge the decoded completion-frame `McpArgs` map into the args assembled
 * from streamed `args_text_delta` snapshots.
 *
 * The completion frame is authoritative for the scalars it carries — but it
 * can omit oversized parameters entirely and can downgrade a structured value
 * to its raw string fallback when `decodeMcpArgValue` cannot parse it as
 * JSON. Overwriting the streamed args wholesale therefore loses data (e.g.
 * the task tool's `tasks` array on multi-agent dispatches, issue #2615).
 *
 * Rules per key:
 * - completion key absent  → keep the streamed value.
 * - completion is a string while the streamed value is structured (object or
 *   array) → keep the streamed value (the completion frame downgraded it).
 * - otherwise               → completion wins.
 */
export function mergeCursorMcpToolCallArgs(
	streamed: Record<string, unknown> | undefined,
	completion: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(streamed ?? {}) };
	if (!completion) return merged;
	for (const [key, completionValue] of Object.entries(completion)) {
		const streamedValue = merged[key];
		if (typeof completionValue === "string" && streamedValue !== null && typeof streamedValue === "object") {
			continue;
		}
		merged[key] = completionValue;
	}
	return merged;
}

function endCurrentTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream, state: BlockState): void {
	const block = state.currentTextBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "text_end",
		contentIndex: idx,
		content: block.text,
		partial: output,
	});
	state.setTextBlock(null);
}

function endCurrentThinkingBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const block = state.currentThinkingBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "thinking_end",
		contentIndex: idx,
		content: block.thinking,
		partial: output,
	});
	state.setThinkingBlock(null);
}

/**
 * Synthesize a completed `toolCall` content block for a Cursor exec-channel
 * native tool (`shell`, `read`, `write`, `grep`, `ls`, `delete`, `diagnostics`).
 *
 * Args arrive complete on the exec message, so the block opens and closes in
 * one step — no partial-JSON streaming path. Without this the persisted
 * assistant message carries only text/thinking blocks, and on replay the
 * following `toolResult` messages have no matching `toolCall.id` in
 * `renderSessionContext`, so they render as header-less `⎿` lines beneath the
 * last text block instead of proper tool components (issue #4348).
 *
 * The block is stamped with {@link kCursorExecResolved} so the shared
 * `agent-loop.ts` execution pass skips it: the exec channel has already
 * dispatched this call, so treating the block as runnable would re-execute the
 * same side-effecting tool a second time.
 *
 * "Already dispatched" is not "already finished, elsewhere". The handler is a
 * caller-supplied `execHandler` and it runs IN THIS PROCESS, and this function
 * pushes the block BEFORE `resolveExecHandler` is awaited. So between this
 * block appearing and its `toolResult` arriving, the tool is running locally
 * and may be part-way through its side effects. A stream reset in that window
 * leaves a call that is neither safe to retry verbatim nor answered, which is
 * why `buildAbortedTurnLedger` in `agent-loop.ts` reports such a block as
 * "started, no result recorded" rather than as never run. Do not restate this
 * as server-side execution: that wording is what made the harness's
 * "nothing is in flight at abort time" claim look unconditional.
 *
 * Exported for tests to exercise ordering with adjacent text/thinking blocks.
 */
export function synthesizeCursorExecToolCall(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): void {
	endCurrentTextBlock(output, stream, state);
	endCurrentThinkingBlock(output, stream, state);
	const block: ToolCallState = {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: args,
		[kStreamingBlockIndex]: output.content.length,
		[kStreamingBlockKind]: "cursor-exec",
		[kCursorExecResolved]: true,
	};
	output.content.push(block);
	const idx = output.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
	stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
}

/** Structural view of the generated `InteractionUpdate` oneof, limited to the
 *  fields the streaming state machine reads. Same idiom as
 *  {@link CursorToolCallView}: real protobuf messages satisfy it and
 *  test harnesses can fabricate updates without protobuf branding. */
export interface InteractionUpdateView {
	message?: {
		case?: string;
		value?: {
			/** textDelta / thinkingDelta */
			text?: string;
			/** toolCallStarted / toolCallCompleted */
			toolCall?: CursorToolCallView;
			callId?: string;
			/** toolCallDelta / partialToolCall: cumulative args-JSON snapshot */
			argsTextDelta?: string;
			/** tokenDelta */
			tokens?: number;
		};
	};
}

/**
 * The block a tool-call update is about.
 *
 * WHY. Cursor opens every call of a batch before it streams any of their
 * arguments, and it completes them in issue order afterwards: `started(A)`,
 * `started(B)`, `completed(A)`, `completed(B)`. A single "current tool call"
 * pointer therefore names B by the time A's arguments and completion arrive,
 * so A's arguments were written onto B and A kept the empty object it opened
 * with. A recorded two-call turn persisted `set_cwd({})` beside
 * `eval({path, i})` — B's name over A's arguments — and the empty one then
 * reached the tool validator as a second execution under an id that already
 * had a result. Every update carries `call_id`; route by it.
 *
 * A call id that names no open block returns nothing rather than the pointer:
 * writing an unrecognised call's arguments onto whatever is current is the
 * defect, not a fallback. The pointer answers only an update that carries no
 * id at all, which is how a provider fixture without one keeps working.
 */
function toolCallBlockFor(
	output: AssistantMessage,
	state: BlockState,
	callId: string | undefined,
): ToolCallState | null {
	if (!callId) return state.currentToolCall;
	for (let i = output.content.length - 1; i >= 0; i--) {
		const block = output.content[i];
		if (block?.type !== "toolCall") continue;
		const candidate = block as ToolCallState;
		if (candidate.id === callId || candidate[kCursorWireCallId] === callId) return candidate;
	}
	return null;
}

type InteractionUpdateValue = NonNullable<NonNullable<InteractionUpdateView["message"]>["value"]>;

type InteractionUpdateHandler = (
	value: InteractionUpdateValue,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
) => void;

/** The variants `InteractionUpdate.message` declares, from the generated descriptor's type. */
type InteractionUpdateCase = NonNullable<InteractionUpdate["message"]["case"]>;

function appendTextDelta(
	value: InteractionUpdateValue,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	state.setFirstTokenTime();
	const delta = value.text || "";
	let block = state.currentTextBlock;
	if (!block) {
		block = { type: "text", text: "", [kStreamingBlockIndex]: output.content.length };
		output.content.push(block);
		state.setTextBlock(block);
		stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
	}
	block.text += delta;
	stream.push({ type: "text_delta", contentIndex: output.content.indexOf(block), delta, partial: output });
}

function appendThinkingDelta(
	value: InteractionUpdateValue,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	state.setFirstTokenTime();
	const delta = value.text || "";
	let block = state.currentThinkingBlock;
	if (!block) {
		block = { type: "thinking", thinking: "", [kStreamingBlockIndex]: output.content.length };
		output.content.push(block);
		state.setThinkingBlock(block);
		stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
	}
	block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: output.content.indexOf(block), delta, partial: output });
}

function openToolCallBlock(
	block: ToolCallState,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	output.content.push(block);
	state.setToolCall(block);
	stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
}

function mcpToolCallBlock(
	mcpArgs: CursorMcpArgsView,
	wireCallId: string | undefined,
	contentIndex: number,
	state: BlockState,
): ToolCallState {
	const toolCallId = mcpArgs.toolCallId || wireCallId || crypto.randomUUID();
	// The started frame already carries the whole argument map for a call
	// Cursor decided server-side, and a call whose completion never
	// arrives keeps nothing else: an interrupted turn persisted `{}` for
	// arguments the wire had already delivered, and the loop then deleted
	// the block as one whose arguments never finished streaming — which
	// is how a call that HAD run was reported as never run.
	const startedArgs = decodeMcpArgsMap(mcpArgs.args) ?? {};
	const hasStartedArgs = Object.keys(startedArgs).length > 0;
	return {
		type: "toolCall",
		id: toolCallId,
		name: mcpArgs.name || mcpArgs.toolName || "",
		arguments: startedArgs,
		[kStreamingBlockIndex]: contentIndex,
		// A complete argument map is a complete argument buffer: the loop
		// reads this marker to tell a finished call from a truncated one.
		[kStreamingPartialJson]: hasStartedArgs ? JSON.stringify(startedArgs) : "",
		...(hasStartedArgs ? { [kCursorSeededArgs]: true } : {}),
		[kStreamingBlockKind]: "mcp",
		...(wireCallId ? { [kCursorWireCallId]: wireCallId } : {}),
		// The exec channel may have dispatched this call before its block
		// opened, in which case the tool has already run and answered.
		...(state.execDispatches.has(toolCallId) ? { [kCursorExecResolved]: true } : {}),
	};
}

function todoToolCallBlock(
	todoArgs: Record<string, unknown>,
	wireCallId: string | undefined,
	contentIndex: number,
): ToolCallState {
	return {
		type: "toolCall",
		id: wireCallId || crypto.randomUUID(),
		name: "todo",
		arguments: todoArgs,
		[kStreamingBlockIndex]: contentIndex,
		// Todo args arrive whole, but the block is still open until its
		// completion: the same marker every open block carries, so
		// end-of-stream closes this one too.
		[kStreamingPartialJson]: JSON.stringify(todoArgs),
		[kCursorSeededArgs]: true,
		[kStreamingBlockKind]: "todo",
		...(wireCallId ? { [kCursorWireCallId]: wireCallId } : {}),
	};
}

function startToolCall(
	value: InteractionUpdateValue,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	endCurrentTextBlock(output, stream, state);
	endCurrentThinkingBlock(output, stream, state);
	const toolCall = value.toolCall;
	if (!toolCall) return;
	const mcpCall = mcpToolCallOf(toolCall);
	if (mcpCall) {
		openToolCallBlock(
			mcpToolCallBlock(mcpCall.args || {}, value.callId, output.content.length, state),
			output,
			stream,
			state,
		);
		return;
	}
	const todoArgs = buildTodoArgs(toolCall);
	if (todoArgs) {
		openToolCallBlock(todoToolCallBlock(todoArgs, value.callId, output.content.length), output, stream, state);
	}
}

function streamToolCallArgs(
	value: InteractionUpdateValue,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const target = toolCallBlockFor(output, state, value.callId);
	if (target?.[kStreamingBlockKind] !== "mcp") return;
	// Cursor's `args_text_delta` is "aggregated args text so far" per agent.proto: each
	// delta is a cumulative snapshot of the JSON-text args. Strip the prefix we already
	// have to recover the new suffix; fall back to treating the value as an incremental
	// fragment when it doesn't extend the buffer.
	const snapshot: string = value.argsTextDelta || "";
	const buffered = target[kStreamingPartialJson] ?? "";
	// A buffer seeded from the started frame is a complete argument map, not
	// a prefix of what is now streaming. Streamed text supersedes it whole;
	// appending would concatenate two JSON objects into an unparseable one.
	const seeded = target[kCursorSeededArgs] === true;
	const current = seeded && !snapshot.startsWith(buffered) ? "" : buffered;
	const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
	if (chunk.length === 0) return;
	const nextBuffer = current + chunk;
	target[kStreamingPartialJson] = nextBuffer;
	target[kCursorSeededArgs] = undefined;
	// Throttle mid-stream parses to keep total parse work O(N) instead of O(N²)
	// in the argument-buffer length; the authoritative full parse runs in
	// `toolCallCompleted` (mcp branch) and the fallback end-of-stream path.
	const throttled = parseStreamingJsonThrottled(nextBuffer, target[kStreamingLastParseLen] ?? 0);
	if (throttled) {
		target.arguments = throttled.value;
		target[kStreamingLastParseLen] = throttled.parsedLen;
	}
	stream.push({ type: "toolcall_delta", contentIndex: output.content.indexOf(target), delta: chunk, partial: output });
}

/** The arguments a completed call ends with, or `undefined` to keep the ones it has. */
function completedToolCallArgs(
	target: ToolCallState,
	toolCall: CursorToolCallView | undefined,
): Record<string, unknown> | undefined {
	const kind = target[kStreamingBlockKind];
	if (kind === "mcp") {
		// Authoritative full parse of the accumulated argument buffer; the delta
		// path throttles mid-stream parses, so `arguments` may lag the buffer.
		const partial = target[kStreamingPartialJson];
		const streamed = partial ? parseStreamingJson(partial) : target.arguments;
		const decodedArgs = decodeMcpArgsMap(toolCall ? mcpToolCallOf(toolCall)?.args?.args : undefined);
		return mergeCursorMcpToolCallArgs(streamed as Record<string, unknown> | undefined, decodedArgs);
	}
	return kind === "todo" && toolCall ? (buildTodoArgs(toolCall) ?? undefined) : undefined;
}

function completeToolCall(
	value: InteractionUpdateValue,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const target = toolCallBlockFor(output, state, value.callId);
	if (!target) return;
	const args = completedToolCallArgs(target, value.toolCall);
	if (args) target.arguments = args;
	clearStreamingPartialJson(target);
	stream.push({
		type: "toolcall_end",
		contentIndex: output.content.indexOf(target),
		toolCall: target,
		partial: output,
	});
	if (state.currentToolCall === target) state.setToolCall(null);
}

/**
 * The variants the streaming state machine acts on, one handler each. Every
 * other variant is dropped. `turnEnded` is deliberately absent: it is the
 * turn's only completion signal and `streamCursor` owns it, because a turn
 * that never receives one did not finish and must not report that it did.
 */
const INTERACTION_UPDATE_HANDLERS: Partial<Record<InteractionUpdateCase, InteractionUpdateHandler>> = {
	textDelta: appendTextDelta,
	thinkingDelta: appendThinkingDelta,
	thinkingCompleted: (_value, output, stream, state) => endCurrentThinkingBlock(output, stream, state),
	toolCallStarted: startToolCall,
	toolCallDelta: streamToolCallArgs,
	partialToolCall: streamToolCallArgs,
	toolCallCompleted: completeToolCall,
	tokenDelta: (value, _output, _stream, state) => {
		state.usage.completionTokens += value.tokens || 0;
		state.usage.fold();
	},
};

/** Exported for tests: drives one Cursor interaction update through the streaming state machine. */
export function processInteractionUpdate(
	update: InteractionUpdateView,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const updateCase = update.message?.case;
	log("interactionUpdate", updateCase, update.message?.value);
	// `Object.hasOwn`, not indexing: a variant named for an `Object.prototype`
	// member would otherwise resolve to that member and be called as a handler.
	if (updateCase === undefined || !Object.hasOwn(INTERACTION_UPDATE_HANDLERS, updateCase)) return;
	const handler = INTERACTION_UPDATE_HANDLERS[updateCase as InteractionUpdateCase];
	handler?.(update.message?.value ?? {}, output, stream, state);
}

/**
 * Map `ConversationTokenDetails.detailed` onto the provider-neutral buckets.
 *
 * The entries are the whole point of the field: `used_tokens` and `max_tokens`
 * are repeated inside it and are already read off the parent. An entry list
 * that is empty means the server sent the wrapper and measured nothing, which
 * is not a reading, so it maps to undefined and leaves the last one standing.
 */
function cursorContextComposition(details?: ConversationTokenDetails): ProviderContextBucket[] | undefined {
	const entries = details?.detailed?.entry;
	if (!entries?.length) return undefined;
	return entries.map(entry => ({
		key: entry.key,
		label: entry.label,
		tokens: entry.tokens,
		chars: entry.chars,
	}));
}

/** Exported for tests: folds one conversation checkpoint into the turn's token account. */
export function handleConversationCheckpointUpdate(
	checkpoint: ConversationStateStructure,
	usage: CursorUsageAccount,
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): void {
	onConversationCheckpoint?.(checkpoint);
	// Most checkpoints carry an empty `token_details`: the server only populates
	// the gauge on some of them. Zero is "not reported", not "the conversation is
	// empty", so an empty one must leave the last real reading standing rather
	// than blank the window and the prompt.
	const maxTokens = checkpoint.tokenDetails?.maxTokens ?? 0;
	if (maxTokens > 0) {
		usage.contextWindow = maxTokens;
	}
	const usedTokens = checkpoint.tokenDetails?.usedTokens ?? 0;
	if (usedTokens > 0) {
		usage.conversationTokens = usedTokens;
	}
	const composition = cursorContextComposition(checkpoint.tokenDetails);
	if (composition) {
		usage.contextComposition = composition;
	}
	usage.fold();
}

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeCursorBlob(blobStore: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
	const blobId = createBlobId(data);
	blobStore.set(Buffer.from(blobId).toString("hex"), data);
	return blobId;
}

function readCursorBlob(blobStore: Map<string, Uint8Array>, blobId: Uint8Array): Uint8Array {
	const data = blobStore.get(Buffer.from(blobId).toString("hex"));
	if (!data) {
		throw new AIError.ValidationError("Cursor blob not found");
	}
	return data;
}

const CURSOR_NATIVE_TOOL_NAMES = new Set(["bash", "read", "write", "delete", "ls", "grep", "lsp", "todo"]);

function buildMcpToolDefinitions(tools: Tool[] | undefined): McpToolDefinition[] {
	if (!tools || tools.length === 0) {
		return [];
	}

	const advertisedTools = tools.filter(tool => !CURSOR_NATIVE_TOOL_NAMES.has(tool.name));
	if (advertisedTools.length === 0) {
		return [];
	}

	return advertisedTools.map(tool => {
		const jsonSchema = toolWireSchema(tool);
		const schemaValue: JsonValue =
			jsonSchema && typeof jsonSchema === "object"
				? (jsonSchema as JsonValue)
				: { type: "object", properties: {}, required: [] };
		const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, schemaValue));
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description || "",
			providerIdentifier: "pi-agent",
			toolName: tool.name,
			inputSchema,
		});
	});
}

/**
 * Extract text content from a user or developer message.
 */
function extractUserMessageText(msg: Message): string {
	if (msg.role !== "user" && msg.role !== "developer") return "";
	const content = msg.content;
	if (typeof content === "string") return content.trim();
	const text = content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
	return text.trim();
}

function hasUserMessageImages(msg: Message): boolean {
	return (
		(msg.role === "user" || msg.role === "developer") &&
		Array.isArray(msg.content) &&
		msg.content.some(item => item.type === "image")
	);
}

type CursorRootPromptContentPart = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };

function buildCursorRootPromptContent(content: string | (TextContent | ImageContent)[]): CursorRootPromptContentPart[] {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? [{ type: "text", text }] : [];
	}
	const parts: CursorRootPromptContentPart[] = [];
	for (const item of content) {
		if (item.type === "text") {
			const text = item.text.trim();
			if (text) {
				parts.push({ type: "text", text });
			}
		} else {
			parts.push({ type: "image", image: item.data, mediaType: item.mimeType });
		}
	}
	return parts;
}

function cursorUserContentKey(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return content.trim();
	}
	const hash = createHash("sha256");
	for (const item of content) {
		hash.update(item.type);
		if (item.type === "text") {
			hash.update(item.text);
		} else {
			hash.update(item.mimeType);
			hash.update(item.data);
		}
	}
	return hash.digest("hex");
}

/**
 * Extract text content from an assistant message.
 */
function extractAssistantMessageText(msg: Message): string {
	if (msg.role !== "assistant") return "";
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

/**
 * Index of the last user/developer message in `messages`, or -1 if none.
 * Used to exclude the current user turn from history builders — it goes in
 * `ConversationActionSchema.userMessageAction`, not in history structures.
 */
function findLastUserMessageIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i].role;
		if (role === "user" || role === "developer") {
			return i;
		}
	}
	return -1;
}

/**
 * Build `ConversationStateStructure.rootPromptMessagesJson` blob IDs for the
 * system prompt plus prior conversation history, as JSON blobs matching
 * Cursor's internal Vercel-AI-SDK-shaped message format.
 *
 * Cursor's server uses `rootPromptMessagesJson` (not `turns[]`) to build the
 * actual model prompt. `turns[]` is UI/display metadata. Without populating
 * this field, multi-turn conversations lose prior context — the model sees
 * only an empty placeholder where historical user turns should be.
 * The active user message is excluded because it is sent in the action.
 */
/**
 * Build the `rootPromptMessagesJson` head: one placeholder system message, and nothing else.
 *
 * The caller's prompt is NOT put here. This server fetches these blobs and then rebuilds the
 * head with its own canned CLI prompt, so a copy placed here is uploaded and discarded: pure
 * duplicate traffic, tens of kilobytes on every turn. The single copy that reaches the model
 * rides on the active user turn (see buildGrpcRequest), and the single-copy suite fails the
 * moment a second copy appears on any channel.
 *
 * The head still carries one entry, because an empty `rootPromptMessagesJson` is not a shape
 * this protocol accepts.
 */
export function buildCursorSystemPromptJsons(): string[] {
	return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
}

function buildRootPromptMessagesJson(
	messages: Message[],
	systemPromptIds: Uint8Array[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): Uint8Array[] {
	const entries: Uint8Array[] = systemPromptIds.slice();
	const pushJson = (obj: unknown) => {
		const bytes = new TextEncoder().encode(JSON.stringify(obj));
		entries.push(storeCursorBlob(blobStore, bytes));
	};

	for (let i = 0; i < messages.length; i++) {
		if (i === activeUserMessageIndex) break;
		const msg = messages[i];
		if (msg.role === "user" || msg.role === "developer") {
			const content = buildCursorRootPromptContent(msg.content);
			if (content.length === 0) continue;
			pushJson({ role: "user", content });
		} else if (msg.role === "assistant") {
			const text = extractAssistantMessageText(msg);
			if (!text) continue;
			pushJson({ role: "assistant", content: [{ type: "text", text }] });
		} else if (msg.role === "toolResult") {
			const text = toolResultToText(msg);
			if (!text) continue;
			const prefix = msg.isError ? "[Tool Error]" : "[Tool Result]";
			pushJson({
				role: "user",
				content: [{ type: "text", text: `${prefix}\n${text}` }],
			});
		}
	}

	return entries;
}

/**
 * Convert context.messages to Cursor's ConversationTurnStructure blob IDs.
 * Groups messages into turns: each turn is a user message followed by the assistant's response.
 * Excludes the active user message (which goes in the action).
 *
 * Each `AgentConversationTurnStructure.user_message`, `steps[]`, and the outer
 * `ConversationStateStructure.turns[]` entry is a blob ID into `blobStore`.
 */
function buildConversationTurns(
	messages: Message[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): Uint8Array[] {
	const turns: Uint8Array[] = [];

	// Find turn boundaries - each turn starts with a user message
	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];

		// Skip non-user messages at the start
		if (msg.role !== "user" && msg.role !== "developer") {
			i++;
			continue;
		}

		// The active user message goes in the action, not turns. A prior user
		// followed by assistant/tool-result messages is complete history and
		// must remain serialized for resume actions.
		if (i === activeUserMessageIndex) {
			break;
		}

		// Create and serialize user message
		const userText = extractUserMessageText(msg);
		if (userText.length === 0 && !hasUserMessageImages(msg)) {
			i++;
			continue;
		}

		const userMessage = createCursorUserMessage(
			msg.content,
			userText,
			deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`),
		);
		const userMessageBytes = toBinary(UserMessageSchema, userMessage);
		const userMessageBlobId = storeCursorBlob(blobStore, userMessageBytes);

		// Collect and serialize steps until next user message
		const stepBlobIds: Uint8Array[] = [];
		i++;

		while (i < messages.length && messages[i].role !== "user" && messages[i].role !== "developer") {
			const stepMsg = messages[i];

			if (stepMsg.role === "assistant") {
				const text = extractAssistantMessageText(stepMsg);
				if (text) {
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text }),
						},
					});
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			} else if (stepMsg.role === "toolResult") {
				// Include tool results as assistant text for context
				const text = toolResultToText(stepMsg);
				if (text) {
					const prefix = stepMsg.isError ? "[Tool Error]" : "[Tool Result]";
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text: `${prefix}\n${text}` }),
						},
					});
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			}

			i++;
		}

		// Create the serialized turn using Structure types. The bytes fields
		// (user_message, steps) are blob IDs resolved through the KV store.
		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBlobId,
			steps: stepBlobIds,
		});
		const turn = create(ConversationTurnStructureSchema, {
			turn: {
				case: "agentConversationTurn",
				value: agentTurn,
			},
		});
		turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
	}

	return turns;
}

/** Exported for tests: decodes Cursor history blobs built from conversation messages. */
export function buildCursorHistoryForTest(
	messages: Message[],
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): {
	rootPromptMessagesJson: unknown[];
	turnUserMessagesJson: JsonValue[];
	turnStepMessagesJson: JsonValue[][];
} {
	const blobStore = new Map<string, Uint8Array>();
	const rootPromptMessagesJson = buildRootPromptMessagesJson(messages, [], blobStore, activeUserMessageIndex).map(
		blobId => JSON.parse(new TextDecoder().decode(readCursorBlob(blobStore, blobId))),
	);
	const turnUserMessagesJson: JsonValue[] = [];
	const turnStepMessagesJson: JsonValue[][] = [];
	for (const turnBlobId of buildConversationTurns(messages, blobStore, activeUserMessageIndex)) {
		const turn = fromBinary(ConversationTurnStructureSchema, readCursorBlob(blobStore, turnBlobId));
		if (turn.turn.case !== "agentConversationTurn") {
			continue;
		}
		const userMessage = fromBinary(UserMessageSchema, readCursorBlob(blobStore, turn.turn.value.userMessage));
		turnUserMessagesJson.push(toJson(UserMessageSchema, userMessage));
		turnStepMessagesJson.push(
			turn.turn.value.steps.map(stepBlobId => {
				const step = fromBinary(ConversationStepSchema, readCursorBlob(blobStore, stepBlobId));
				return toJson(ConversationStepSchema, step);
			}),
		);
	}
	return { rootPromptMessagesJson, turnUserMessagesJson, turnStepMessagesJson };
}
function createCursorUserMessage(
	content: string | (TextContent | ImageContent)[],
	text: string,
	messageId = crypto.randomUUID(),
) {
	const images = typeof content === "string" ? [] : extractImages(content);
	return create(UserMessageSchema, {
		text,
		messageId,
		...(images.length > 0
			? {
					selectedContext: create(SelectedContextSchema, {
						selectedImages: images,
					}),
				}
			: {}),
	});
}

function extractImages(content: (TextContent | ImageContent)[]) {
	return content
		.filter((item): item is ImageContent => item.type === "image")
		.map(image =>
			create(SelectedImageSchema, {
				uuid: crypto.randomUUID(),
				mimeType: image.mimeType,
				dataOrBlobId: {
					case: "data",
					value: Uint8Array.from(Buffer.from(image.data, "base64")),
				},
			}),
		);
}

/**
 * How many times the caller's instruction text appears in what this request will put on the
 * wire: the serialized run request, plus every prompt-head blob it minted (which the server
 * fetches over the same connection).
 *
 * A blob carries its content JSON-encoded, so a copy hidden there reads as `\n` where the
 * original has a newline and would slip past a plain substring search. The escaped spelling is
 * counted as the same copy, which is what caught the head-blob duplicate when it was re-added.
 *
 * History blobs are out of scope on purpose. They carry earlier turns as the caller wrote them,
 * and a caller that puts its own instructions in a message is not this function's business.
 */
function countInstructionCopies(requestBytes: Uint8Array, headBlobs: readonly string[], instructions: string): number {
	const decoder = new TextDecoder();
	const escaped = JSON.stringify(instructions).slice(1, -1);
	const countIn = (text: string): number =>
		countTextOccurrences(text, instructions) + (escaped === instructions ? 0 : countTextOccurrences(text, escaped));
	let copies = countIn(decoder.decode(requestBytes));
	for (const blob of headBlobs) copies += countIn(blob);
	return copies;
}

function countTextOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count += 1;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

/** Build the run request. Exported so a test can read what the active turn carries. */
export async function buildGrpcRequest(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorOptions | undefined,
	state: {
		conversationId: string;
		blobStore: Map<string, Uint8Array>;
		conversationState?: ConversationStateStructure;
	},
): Promise<{
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	conversationState: ConversationStateStructure;
	/**
	 * Hex ids of this request's system-prompt blobs. The kv channel sees only opaque ids, so the
	 * only way a blob miss can be classified as "the system prompt" rather than "some history
	 * entry" is to carry the set the request just minted.
	 */
	systemPromptBlobIds: ReadonlySet<string>;
}> {
	const blobStore = state.blobStore;

	const systemPromptJsons = buildCursorSystemPromptJsons();
	const systemPromptIds = systemPromptJsons.map(json => storeCursorBlob(blobStore, new TextEncoder().encode(json)));

	const activeUserMessageIndex = context.messages.length - 1;
	const activeMessage = context.messages[activeUserMessageIndex];
	const activeUserMessage =
		activeMessage?.role === "user" || activeMessage?.role === "developer" ? activeMessage : undefined;
	let userContent: string | (TextContent | ImageContent)[] | undefined;
	let userText = "";
	let hasUserImages = false;
	if (activeUserMessage?.role === "user" || activeUserMessage?.role === "developer") {
		userContent = activeUserMessage.content;
		if (typeof userContent === "string") {
			userText = userContent.trim();
		} else {
			userText = extractText(userContent);
			hasUserImages = hasImages(userContent);
		}
	}

	// The active user turn is the ONLY thing this server delivers to the model verbatim.
	// It replaces the `rootPromptMessagesJson` head with its own canned CLI prompt (wire
	// capture: the head comes back as [Cursor's system prompt, a bookkeeping blob, the user
	// turn]), and it applies none of `requestContext.rules` — a lone rule reading "every
	// reply must be exactly RULE-OK" changed nothing about the answer. So the assembled
	// prompt, which carries every operator instruction layer, rides on the turn itself.
	const instructions = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	if (instructions.length > 0 && userContent !== undefined) {
		const preamble = `<operator-instructions>\n${instructions}\n</operator-instructions>\n\n`;
		if (typeof userContent === "string") {
			userContent = preamble + userContent;
			userText = userContent.trim();
		} else {
			userContent = [{ type: "text", text: preamble } as TextContent, ...userContent];
			userText = extractText(userContent);
		}
	}

	const action = create(ConversationActionSchema, {
		action:
			userContent && (userText.trim().length > 0 || hasUserImages)
				? {
						case: "userMessageAction",
						value: create(UserMessageActionSchema, {
							userMessage: createCursorUserMessage(userContent, userText),
						}),
					}
				: {
						case: "resumeAction",
						value: create(ResumeActionSchema, {}),
					},
	});

	// Build conversation turns from prior messages, excluding only the active user message
	// when the request is sending one. Resume actions must preserve trailing tool results.
	const turns = buildConversationTurns(context.messages, blobStore, activeUserMessage ? activeUserMessageIndex : -1);

	// Build `rootPromptMessagesJson` from prior messages. Cursor's server uses this
	// field (not `turns[]`) to construct the actual model prompt; if we only send the
	// system prompt here, multi-turn conversations lose prior context and the model
	// sees only the current user message.
	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		context.messages,
		systemPromptIds,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
	);

	// Preserve cached non-history state fields (todos, file states, summaries, etc.)
	// when the system prompt is unchanged; otherwise start fresh.
	const cachedPromptHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
	const hasMatchingPrompt =
		cachedPromptHead.length === systemPromptIds.length &&
		systemPromptIds.every((id, idx) => Buffer.from(cachedPromptHead[idx]).equals(id));
	const baseState =
		state.conversationState && hasMatchingPrompt
			? state.conversationState
			: create(ConversationStateStructureSchema, {
					rootPromptMessagesJson: systemPromptIds,
					turns: [],
					todos: [],
					pendingToolCalls: [],
					previousWorkspaceUris: [],
					fileStates: {},
					fileStatesV2: {},
					summaryArchives: [],
					turnTimings: [],
					subagentStates: {},
					selfSummaryCount: 0,
					readPaths: [],
				});

	// Always override `rootPromptMessagesJson` and `turns` with content freshly built from
	// `context.messages`. The server-echoed checkpoint replaces historical user entries
	// with empty placeholders, so we cannot rely on the cached `rootPromptMessagesJson`.
	const conversationState = create(ConversationStateStructureSchema, {
		...baseState,
		rootPromptMessagesJson,
		turns,
	});

	// Cursor selects reasoning effort by MODEL ID (tier siblings like
	// `gpt-5.4-high`), not a wire param: mapOptionsForApi resolves the
	// requested effort through `thinking.effortRouting` into `wireModelId` so
	// a collapsed family actually changes what the server runs. Models without
	// routing keep the plain requestModelId path.
	const wireModelId = options?.wireModelId ?? model.requestModelId ?? model.id;
	const cursorMaxMode = model.cursorMaxMode === true;
	const modelDetails = create(ModelDetailsSchema, {
		modelId: wireModelId,
		displayModelId: model.id,
		displayName: model.name,
		...(cursorMaxMode ? { maxMode: true } : undefined),
	});
	const requestedModel = create(RequestedModelSchema, {
		modelId: wireModelId,
		maxMode: cursorMaxMode,
	});

	let runRequest: AgentRunRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		requestedModel,
		conversationId: state.conversationId,
	});

	// Tools are sent later via requestContext (exec handshake)

	if (options?.customSystemPrompt) {
		runRequest.customSystemPrompt = options.customSystemPrompt;
	}

	const payloadHook = options?.onPayload;
	if (payloadHook) {
		// The hook is where a host runs its secret redactor, and a redactor WALKS the
		// payload rewriting strings, so it can only be handed something JSON can
		// express. A protobuf message is not: `rootPromptMessagesJson` and the turn
		// entries are blob IDs (`Uint8Array`) and 64-bit fields decode to `bigint`,
		// so the redactor refused the whole request and Cursor failed outright for
		// anyone with secrets configured. Canonical proto3 JSON carries bytes as
		// base64 and 64-bit values as strings; a no-op round-trip is byte-identical.
		const replacementPayload = await payloadHook(toJson(AgentRunRequestSchema, runRequest), model);
		if (replacementPayload !== undefined) {
			runRequest = fromJson(AgentRunRequestSchema, replacementPayload as JsonValue);
		}
	}

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});

	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);

	// Fail closed on both halves of the contract, checked against the bytes about to be sent.
	//
	// DELIVERED: the instructions are on the active user turn, the one field this server hands
	// to the model unchanged. A request carrying none of them runs on Cursor's canned CLI
	// prompt and reports success, which is the failure an operator hit three times.
	//
	// ONCE: they appear on exactly one channel. Uploading the same 40KB prompt again as a
	// request-context rule or as a prompt blob is traffic this server throws away, and a second
	// copy of an instruction payload is a second thing that can drift out of sync.
	if (instructions.length > 0 && userContent !== undefined) {
		const copies = countInstructionCopies(requestBytes, systemPromptJsons, instructions);
		if (copies !== 1) {
			throw new AIError.ProviderResponseError(
				copies === 0
					? "Cursor request carries none of the caller's instructions, so the model would run on Cursor's own prompt"
					: `Cursor request carries the caller's instructions ${copies} times; they belong on the active user turn and nowhere else`,
				{ provider: model.provider, kind: "runtime" },
			);
		}
	}

	const toolNames = context.tools?.map(tool => tool.name) ?? [];
	const detail =
		$env.DEBUG_CURSOR === "2"
			? ` ${JSON.stringify(clientMessage.message.value, debugReplacer, 2)?.slice(0, 2000)}`
			: "";
	log("info", "builtRunRequest", {
		bytes: requestBytes.length,
		tools: toolNames.length,
		toolNames: toolNames.slice(0, 20),
		detail: detail || undefined,
		// Payload breakdown: prefill is on the TTFS critical path, so the size of
		// what we ship (system prompt blobs + advertised tool schemas) is the first
		// thing to look at when first-token latency regresses. Debug-gated only.
		payload: $env.DEBUG_CURSOR
			? {
					systemPromptBlobs: systemPromptJsons.map(json => Buffer.byteLength(json, "utf8")),
					systemPromptBytes: systemPromptJsons.reduce((sum, json) => sum + Buffer.byteLength(json, "utf8"), 0),
					systemPromptText: $env.DEBUG_CURSOR === "2" ? systemPromptJsons : undefined,
					toolSchemaBytes: (context.tools ?? []).map(tool => ({
						name: tool.name,
						description: Buffer.byteLength(tool.description ?? "", "utf8"),
						schema: Buffer.byteLength(JSON.stringify(toolWireSchema(tool) ?? {}), "utf8"),
					})),
					toolText:
						$env.DEBUG_CURSOR === "2"
							? (context.tools ?? []).map(tool => ({
									name: tool.name,
									description: tool.description ?? "",
									schema: JSON.stringify(toolWireSchema(tool) ?? {}),
								}))
							: undefined,
				}
			: undefined,
	});

	return {
		requestBytes,
		blobStore,
		conversationState,
		systemPromptBlobIds: new Set(systemPromptIds.map(id => Buffer.from(id).toString("hex"))),
	};
}

function hasImages(content: (TextContent | ImageContent)[]): boolean {
	return content.some(item => item.type === "image");
}
function extractText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
