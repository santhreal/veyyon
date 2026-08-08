import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import http2 from "node:http2";
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
	type CursorRule,
	CursorRuleSchema,
	CursorRuleTypeGlobalSchema,
	CursorRuleTypeSchema,
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
import { calculateCost, emptyUsage } from "@veyyon/catalog/models";
import { CURSOR_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { logger } from "@veyyon/utils";
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
	CursorRuleInput,
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
	clearStreamingPartialJson,
	kCursorExecResolved,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { toolWireSchema } from "../utils/schema/wire";

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
/**
 * The rules this process has actually put on the wire for a conversation, by content.
 *
 * The rules channel is the ONLY way a Cursor turn carries the caller's system prompt and the
 * operator's instruction files, and it is driven by the SERVER: nothing leaves the client until a
 * `requestContextArgs` ask arrives. A turn where the ask never comes therefore runs on Cursor's
 * canned CLI prompt with none of the caller's instructions, which is exactly the failure the
 * kv-channel blob miss already fails closed on.
 *
 * The value is a FINGERPRINT rather than a flag, because "this conversation received something
 * once" is not the guarantee that matters. The operator can edit an instruction file, reload, or
 * move the session mid-conversation, and the caller composes the new bytes on the next turn; if
 * the server does not ask again, those bytes never arrive and a flag would call that delivered.
 * Comparing content is what makes a CHANGED instruction set an undelivered one.
 *
 * Bounded like the two caches above, and for the same reason.
 */
const conversationRulesDelivered = new BoundedLruMap<string, string>(CURSOR_CONVERSATION_CACHE_MAX);

/**
 * Identity of a composed rule set: every path and every byte, in order.
 *
 * Order matters as much as content. The caller hands the rules over in ascending authority, so a
 * reordering is a different instruction set even when the bytes are the same multiset.
 */
function cursorRulesFingerprint(rules: readonly CursorRule[]): string {
	const hash = createHash("sha256");
	for (const rule of rules) {
		hash.update(rule.fullPath);
		hash.update("\u0000");
		hash.update(rule.content);
		hash.update("\u0000");
	}
	return hash.digest("hex");
}

export interface CursorOptions extends StreamOptions {
	customSystemPrompt?: string;
	conversationId?: string;
	execHandlers?: CursorExecHandlers;
	onToolResult?: CursorToolResultHandler;
	/** Operator-owned instruction files for the `requestContext.rules` channel (see {@link CursorRuleInput}). */
	cursorRules?: CursorRuleInput[];
	/** Wire model uid selected after thinking-effort routing (see mapOptionsForApi). */
	wireModelId?: string;
}

const CONNECT_END_STREAM_FLAG = 0b00000010;

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

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		const error = payload?.error;
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : "Unknown error";
			return new AIError.ProviderResponseError(`Connect error ${code}: ${message}`, { kind: "envelope" });
		}
		return null;
	} catch {
		return new AIError.ProviderResponseError("Failed to parse Connect end stream", { kind: "envelope" });
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

export const streamCursor: StreamFunction<"cursor-agent"> = (
	model: Model<"cursor-agent">,
	context: Context,
	options?: CursorOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-agent" as Api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const usageAccount = createCursorUsageAccount(model, output);

		let h2Client: http2.ClientHttp2Session | null = null;
		let h2Request: http2.ClientHttp2Stream | null = null;
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let debugResponseLogPromise: Promise<RequestDebugResponseLog | undefined> | undefined;
		// The run's AbortSignal is shared across every LLM round (agent-loop.ts
		// passes the same object each round when harmony/owned-dialect are off), so
		// an abort listener that is never removed accumulates one closure per round
		// — each pinning that round's h2 stream/client. Hoist the handler so the
		// finally can detach it the moment this round settles (leak fix).
		const abortSignal = options?.signal;
		let abortHandler: (() => void) | undefined;

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(undefined, "Cursor API key (access token) is required");
			}

			const conversationId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
			const blobStore = conversationBlobStores.get(conversationId) ?? new Map<string, Uint8Array>();
			conversationBlobStores.set(conversationId, blobStore);
			const cachedState = conversationStateCache.get(conversationId);
			const { requestBytes, conversationState, systemPromptBlobIds } = await buildGrpcRequest(
				model,
				context,
				options,
				{ conversationId, blobStore, conversationState: cachedState },
			);
			conversationStateCache.set(conversationId, conversationState);
			const requestContextTools = buildMcpToolDefinitions(context.tools);
			// Composed once per request: the system prompt plus the caller's operator-owned
			// files, delivered when the server asks for the request context (see buildCursorRules).
			const requestContextRules = buildCursorRules(context.systemPrompt, options?.cursorRules);

			const baseUrl = model.baseUrl || CURSOR_API_URL;
			const requestPath = "/agent.v1.AgentService/Run";
			const requestHeaders = {
				":method": "POST",
				":path": requestPath,
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
						url: new URL(requestPath, baseUrl).toString(),
						headers: requestHeaders,
						bodyBase64: Buffer.from(requestBytes).toString("base64"),
					})
				: undefined;

			const proxyUrl = shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(model.provider);
			if (proxyUrl) {
				const tlsSocket = await connectProxiedSocket(proxyUrl, baseUrl, {
					signal: options?.signal,
					timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
				});
				h2Client = http2.connect(baseUrl, {
					createConnection: () => tlsSocket,
				});
			} else {
				h2Client = http2.connect(baseUrl);
			}

			h2Request = h2Client.request(requestHeaders);

			stream.push({ type: "start", partial: output });

			let pendingBuffer = Buffer.alloc(0);
			let endStreamError: Error | null = null;
			/**
			 * Fail this turn from inside a server-message handler.
			 *
			 * Reuses the `endStreamError` channel a Connect end-stream error already uses (the outer
			 * promise rejects with it), rather than throwing: a throw out of `handleServerMessage` is
			 * caught by the `.catch` below and cannot stop the turn. The first cause wins, so a later
			 * end-stream error cannot overwrite the reason the turn was actually abandoned.
			 */
			const failTurn = (error: Error): void => {
				if (endStreamError) return;
				endStreamError = error;
				h2Request?.close();
			};
			let currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentToolCall: ToolCallState | null = null;

			const state: BlockState = {
				get currentTextBlock() {
					return currentTextBlock;
				},
				get currentThinkingBlock() {
					return currentThinkingBlock;
				},
				get currentToolCall() {
					return currentToolCall;
				},
				get firstTokenTime() {
					return firstTokenTime;
				},
				setTextBlock: b => {
					currentTextBlock = b;
				},
				setThinkingBlock: b => {
					currentThinkingBlock = b;
				},
				setToolCall: t => {
					currentToolCall = t;
				},
				setFirstTokenTime: () => {
					if (!firstTokenTime) firstTokenTime = performance.now();
				},
				usage: usageAccount,
			};

			const onConversationCheckpoint = (checkpoint: ConversationStateStructure) => {
				conversationStateCache.set(conversationId, checkpoint);
			};

			let resolveH2: (() => void) | undefined;
			// `turnEnded` is the only thing that says the server finished this turn.
			// The h2 stream also ends when the connection simply stops, and those two
			// are not the same event.
			let turnCompleted = false;
			// Whether THIS turn answered a `requestContextArgs` ask. Distinct from the
			// conversation ledger: a turn that did not deliver is only a fault when the
			// conversation has never delivered either.
			let requestContextDelivered = false;

			h2Request.on("response", headers => {
				debugResponseLogPromise = debugSession?.openResponseLog(
					`HTTP/2 ${headers[":status"] ?? ""}`.trim(),
					headers,
				);
			});

			h2Request.on("data", (chunk: Buffer) => {
				if (debugResponseLogPromise) {
					void debugResponseLogPromise.then(log => {
						log?.write(chunk);
					});
				}
				pendingBuffer = Buffer.concat([pendingBuffer, chunk]);

				while (pendingBuffer.length >= 5) {
					const flags = pendingBuffer[0];
					const msgLen = pendingBuffer.readUInt32BE(1);
					if (pendingBuffer.length < 5 + msgLen) break;

					const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
					pendingBuffer = pendingBuffer.subarray(5 + msgLen);

					if (flags & CONNECT_END_STREAM_FLAG) {
						const endError = parseConnectEndStream(messageBytes);
						if (endError) {
							endStreamError = endError;
							h2Request?.close();
						}
						continue;
					}

					try {
						const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
						const isTurnEnded =
							serverMessage.message.case === "interactionUpdate" &&
							serverMessage.message.value.message?.case === "turnEnded";
						void handleServerMessage(
							serverMessage,
							output,
							stream,
							state,
							blobStore,
							h2Request!,
							options?.execHandlers,
							options?.onToolResult,
							requestContextTools,
							requestContextRules,
							onConversationCheckpoint,
							{
								systemPromptBlobIds,
								onFatal: failTurn,
								onRequestContextDelivered: () => {
									requestContextDelivered = true;
								},
							},
						).catch(error => {
							// `log` is a no-op unless DEBUG_CURSOR is set, so every failure inside a server-message
							// handler used to vanish: an exec handler that threw, a malformed interaction update, a
							// checkpoint that could not be applied. The turn then completed as though nothing had
							// gone wrong. Report it for real and keep the best-effort shape.
							logger.warn("Cursor server message handler failed", {
								model: model.id,
								messageCase: serverMessage.message.case,
								error: errorMessage(error),
							});
						});

						// The one place the turn is declared over. Both the resolve and the
						// completion check below read this, so there is no second opinion.
						if (isTurnEnded) turnCompleted = true;
						if (isTurnEnded && resolveH2) {
							const r = resolveH2;
							resolveH2 = undefined;
							r();
						}
					} catch (e) {
						log("error", "parseServerMessage", { error: String(e) });
					}
				}
			});

			h2Request.write(frameConnectMessage(requestBytes));

			const sendHeartbeat = () => {
				if (!h2Request || h2Request.closed) {
					return;
				}
				const heartbeatMessage = create(AgentClientMessageSchema, {
					message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
				});
				const heartbeatBytes = toBinary(AgentClientMessageSchema, heartbeatMessage);
				h2Request.write(frameConnectMessage(heartbeatBytes));
			};

			heartbeatTimer = setInterval(sendHeartbeat, 5000);

			await new Promise<void>((resolve, reject) => {
				resolveH2 = resolve;

				const closeDebugLog = async (): Promise<void> => {
					const log = await debugResponseLogPromise;
					await log?.close();
				};

				h2Request!.on("trailers", trailers => {
					const status = trailers["grpc-status"];
					const msg = trailers["grpc-message"];
					if (status && status !== "0") {
						void closeDebugLog().finally(() => {
							reject(
								new AIError.ProviderResponseError(
									`gRPC error ${status}: ${decodeURIComponent(String(msg || ""))}`,
									{ kind: "envelope" },
								),
							);
						});
					}
				});

				h2Request!.on("end", () => {
					resolveH2 = undefined;
					void closeDebugLog()
						.then(() => {
							if (endStreamError) {
								reject(endStreamError);
								return;
							}
							resolve();
						})
						.catch(reject);
				});

				h2Request!.on("error", error => {
					void closeDebugLog().finally(() => reject(error));
				});

				if (abortSignal) {
					abortHandler = () => {
						h2Request?.close();
						void closeDebugLog().finally(() => {
							reject(new AIError.RequestAbortError());
						});
					};
					// Already aborted before we attached: the event will never fire, so
					// run the handler once synchronously instead of hanging the round.
					if (abortSignal.aborted) abortHandler();
					// { once: true } auto-detaches if it fires; the finally detaches it
					// on every normal completion so it never outlives this one round.
					else abortSignal.addEventListener("abort", abortHandler, { once: true });
				}
			});

			// The stream is over. Whether the TURN is over is a different question,
			// and only `turnEnded` answers it: a dropped connection that happens to
			// close cleanly reaches here with a half-written reply. Reporting "stop"
			// for that persisted a truncated turn as a finished one, and the compaction
			// anchor then trusted its partial token counts. Same treatment the other
			// providers give a stream that ends with no finish reason.
			if (!turnCompleted) {
				throw new AIError.ProviderResponseError(
					"Cursor stream ended without a turn_ended update (connection dropped or response truncated)",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}

			// The delivery invariant. `requestContextRules` carries the caller's system prompt
			// and the operator's instruction files, and it is the ONLY channel Cursor honors for
			// them: on a cursor-agent model the coding-agent deliberately inlines no context
			// files in the prompt blobs, because the server discards those. But nothing here
			// pushes the rules; the SERVER decides whether to ask, and a turn where the ask
			// never arrives simply runs on Cursor's canned CLI prompt with none of the
			// operator's instructions and reports success. That is the failure an operator hit
			// twice, and it looked exactly like a normal turn both times.
			//
			// A later turn in a conversation the server already holds THESE rules for
			// legitimately gets no ask, which is why the ledger is consulted rather than this
			// turn alone. Anything else is a drop: never delivered at all, or delivered when the
			// instructions were different, which is the same fault one edit later.
			const rulesFingerprint = cursorRulesFingerprint(requestContextRules);
			if (requestContextDelivered) {
				conversationRulesDelivered.set(conversationId, rulesFingerprint);
			} else if (
				requestContextRules.length > 0 &&
				conversationRulesDelivered.get(conversationId) !== rulesFingerprint
			) {
				throw new AIError.ProviderResponseError(
					`Cursor completed a turn without ever requesting the request context, so the ${requestContextRules.length} rule(s) carrying the system prompt and the operator's instruction files were never delivered and the model ran on Cursor's own prompt. Retry the turn; if it repeats, the account or model is not being served the agent protocol and a non-cursor model is the way forward.`,
					{ provider: model.provider, kind: "runtime" },
				);
			}

			endCurrentTextBlock(output, stream, state);
			endCurrentThinkingBlock(output, stream, state);
			if (state.currentToolCall) {
				const idx = output.content.indexOf(state.currentToolCall);
				state.currentToolCall.arguments = parseStreamingJson(state.currentToolCall[kStreamingPartialJson]);
				clearStreamingPartialJson(state.currentToolCall);
				stream.push({
					type: "toolcall_end",
					contentIndex: idx,
					toolCall: state.currentToolCall,
					partial: output,
				});
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			const log = await debugResponseLogPromise;
			await log?.close();
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			h2Request?.close();
			h2Client?.close();
			// Detach the abort listener so it cannot outlive this round on the
			// shared run signal (removeEventListener is a no-op if it already fired).
			if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
		}
	})();

	return stream;
};

export type ToolCallState = ToolCall & {
	[kStreamingBlockIndex]: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingBlockKind]: "mcp" | "todo" | "cursor-exec";
	[kCursorExecResolved]?: true;
};

/**
 * Every token number Cursor puts on the wire, and the only place any of them
 * becomes `usage`.
 *
 * Cursor reports two quantities and neither one is a usage object.
 * `TokenDeltaUpdate.tokens` is an increment of THIS turn's completion.
 * `ConversationTokenDetails` is a gauge of the WHOLE conversation against the
 * model's window: `used_tokens` counts the system prompt, the tool schemas, the
 * rules, the skills, the subagent definitions and the conversation, and it is
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
	requestContextRules: CursorRule[],
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
				requestContextRules,
				output,
				stream,
				state,
				delivery,
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
 * `onRequestContextDelivered` is the other half of the same guarantee on the other channel. Both
 * channels can drop the caller's instructions without any error, so both report what they actually
 * did and let the turn decide.
 */
interface CursorTurnDelivery {
	systemPromptBlobIds: ReadonlySet<string>;
	/** Fails the turn. Wired to the same `endStreamError` channel a Connect end-stream error uses. */
	onFatal: (error: Error) => void;
	/** Called once the `requestContextResult` frame carrying the rules has been written. */
	onRequestContextDelivered?: () => void;
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
	sendExecClientMessage(h2Request, execMsg, "shellStream", create(ShellStreamSchema, { event }));
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

async function handleShellStreamArgs(
	args: ShellArgs,
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<void> {
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

	// Buffer for incomplete ANSI sequences across chunks
	let stdoutBuffer = "";
	let stderrBuffer = "";

	const incompleteEscapeRegex = /\x1b(|\[|\[\d*|\[\?|\[\?\d*|\]\d*;?)$/;

	const flushStdout = () => {
		if (stdoutBuffer) {
			let safeEnd = stdoutBuffer.length;
			const match = stdoutBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stdoutBuffer.length - match[0].length;
			}
			const toSend = stdoutBuffer.slice(0, safeEnd);
			const remaining = stdoutBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stdout",
					value: create(ShellStreamStdoutSchema, { data: sanitizeText(toSend) }),
				});
			}
			stdoutBuffer = remaining;
		}
	};

	const flushStderr = () => {
		if (stderrBuffer) {
			let safeEnd = stderrBuffer.length;
			const match = stderrBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stderrBuffer.length - match[0].length;
			}
			const toSend = stderrBuffer.slice(0, safeEnd);
			const remaining = stderrBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stderr",
					value: create(ShellStreamStderrSchema, { data: sanitizeText(toSend) }),
				});
			}
			stderrBuffer = remaining;
		}
	};

	let stdoutFlushTimer: NodeJS.Timeout | null = null;
	let stderrFlushTimer: NodeJS.Timeout | null = null;

	const scheduleStdoutFlush = () => {
		if (!stdoutFlushTimer) {
			stdoutFlushTimer = setTimeout(() => {
				stdoutFlushTimer = null;
				flushStdout();
			}, 100);
		}
	};

	const scheduleStderrFlush = () => {
		if (!stderrFlushTimer) {
			stderrFlushTimer = setTimeout(() => {
				stderrFlushTimer = null;
				flushStderr();
			}, 100);
		}
	};

	const streamCallbacks: CursorShellStreamCallbacks = {
		onStdout(data: string) {
			stdoutBuffer += data;
			if (stdoutBuffer.includes("\n") || stdoutBuffer.length > 4096) {
				if (stdoutFlushTimer) {
					clearTimeout(stdoutFlushTimer);
					stdoutFlushTimer = null;
				}
				flushStdout();
			} else {
				scheduleStdoutFlush();
			}
		},
		onStderr(data: string) {
			stderrBuffer += data;
			if (stderrBuffer.includes("\n") || stderrBuffer.length > 4096) {
				if (stderrFlushTimer) {
					clearTimeout(stderrFlushTimer);
					stderrFlushTimer = null;
				}
				flushStderr();
			} else {
				scheduleStderrFlush();
			}
		},
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
	if (stdoutFlushTimer) clearTimeout(stdoutFlushTimer);
	if (stderrFlushTimer) clearTimeout(stderrFlushTimer);
	flushStdout();
	flushStderr();

	sendShellStreamExitFromResult(h2Request, execMsg, sanitizedExecResult, sendBufferedOutput);
	// Cursor can keep the turn pending when it receives only stream deltas.
	// Send the final structured shellResult as completion acknowledgement.
	sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizedExecResult);
	sendExecClientStreamClose(h2Request, execMsg);

	log("shellStream", "done", { elapsed: performance.now() - startTs });
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
	requestContextRules: CursorRule[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	delivery?: CursorTurnDelivery,
): Promise<void> {
	const execCase = execMsg.message.case;
	log("exec", "dispatch", { execCase, execId: execMsg.execId, hasHandlers: !!execHandlers });
	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, {
			// Populated, DELIBERATELY. `requestContext.rules` is the only channel Cursor's
			// server honors for client instructions: the system-prompt blobs at the
			// `rootPromptMessagesJson` head are requested and then replaced by the server's
			// own canned prompt (wire capture, 2026-08: the checkpoint head rebuilt as
			// [Cursor's system prompt, an empty bookkeeping blob, the user turn], our two
			// blobs nowhere in it), so a veyyon turn ran with zero veyyon context. The
			// system prompt therefore goes here as one `global` rule, followed by the
			// operator-owned context files the caller composed (veyyon's global and profile
			// AGENTS.md, one rule per file with its real path, the shape cursor-agent itself
			// uses for AGENTS.md). What must NEVER appear here is repository content
			// (`.cursor/rules/*.mdc`, a checked-in AGENTS.md): a repository may not configure
			// the agent. That exclusion cannot be re-implemented at this layer, because the
			// provider never reads the filesystem: rule content arrives pre-composed from
			// the caller, which owns provenance. Emptying this field again reverts every
			// Cursor model to Cursor's canned CLI prompt with none of the operator's
			// instructions; do not.
			rules: requestContextRules,
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

		sendExecClientMessage(h2Request, execMsg, "requestContextResult", requestContextResult);
		// The turn's only proof that the caller's instructions actually left this process.
		// Recorded AFTER the write, so a throw above cannot report a delivery that never
		// happened. `streamCursor` fails the turn when this never fires (see the delivery
		// invariant at the end of the round).
		delivery?.onRequestContextDelivered?.();
		log("execClient", "requestContextResult", {
			rules: requestContextRules.map(rule => ({
				fullPath: rule.fullPath,
				bytes: Buffer.byteLength(rule.content, "utf8"),
			})),
			// The content itself only at the verbose level: it is the operator's own
			// instruction text, and the checkpoint echo already carries it, but a level-1
			// log should stay a shape summary.
			ruleText:
				$env.DEBUG_CURSOR === "2"
					? requestContextRules.map(rule => ({ fullPath: rule.fullPath, content: rule.content }))
					: undefined,
		});
		return;
	}

	if (!execCase) {
		return;
	}

	switch (execCase) {
		case "readArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.read?.bind(execHandlers),
				onToolResult,
				toolResult => buildReadResultFromToolResult(args.path, toolResult),
				reason => buildReadRejectedResult(args.path, reason),
				error => buildReadErrorResult(args.path, error),
			);
			sendExecClientMessage(h2Request, execMsg, "readResult", execResult);
			return;
		}
		case "lsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
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
			sendExecClientMessage(h2Request, execMsg, "lsResult", execResult);
			return;
		}
		case "grepArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			// Cursor's model sometimes emits `grepArgs` with an empty `pattern` and a
			// non-empty `glob`, expecting grep to list files matching the glob. Reject
			// that up front with an actionable error so the model retries with a real
			// regex or switches to `ls`/`read`, instead of the local grep tool
			// surfacing a bare "Pattern must not be empty" (issue #4574) after the
			// synthesized block has already been persisted with a placeholder pattern.
			const emptyPatternError = emptyGrepPatternRejection(args.pattern, args.glob);
			if (emptyPatternError !== null) {
				sendExecClientMessage(h2Request, execMsg, "grepResult", buildGrepErrorResult(emptyPatternError));
				return;
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
			sendExecClientMessage(h2Request, execMsg, "grepResult", execResult);
			return;
		}
		case "writeArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
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
			sendExecClientMessage(h2Request, execMsg, "writeResult", execResult);
			return;
		}
		case "deleteArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "delete", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.delete?.bind(execHandlers),
				onToolResult,
				toolResult => buildDeleteResultFromToolResult(args.path, toolResult),
				reason => buildDeleteRejectedResult(args.path, reason),
				error => buildDeleteErrorResult(args.path, error),
			);
			sendExecClientMessage(h2Request, execMsg, "deleteResult", execResult);
			return;
		}
		case "shellArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
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
			sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizedExecResult);
			return;
		}
		case "shellStreamArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const shellStreamTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: shellStreamTimeout,
			});
			await handleShellStreamArgs(args, execMsg, h2Request, execHandlers, onToolResult);
			return;
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
			sendExecClientMessage(h2Request, execMsg, "backgroundShellSpawnResult", execResult);
			return;
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
			sendExecClientMessage(h2Request, execMsg, "writeShellStdinResult", execResult);
			return;
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
			sendExecClientMessage(h2Request, execMsg, "fetchResult", execResult);
			return;
		}
		case "diagnosticsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
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
			sendExecClientMessage(h2Request, execMsg, "diagnosticsResult", execResult);
			return;
		}
		case "mcpArgs": {
			const args = execMsg.message.value;
			const mcpCall = decodeMcpCall(args);
			const { execResult } = await resolveExecHandler(
				mcpCall,
				execHandlers?.mcp?.bind(execHandlers),
				onToolResult,
				toolResult => buildMcpResultFromToolResult(mcpCall, toolResult),
				_reason => buildMcpToolNotFoundResult(mcpCall),
				error => buildMcpErrorResult(error),
			);
			sendExecClientMessage(h2Request, execMsg, "mcpResult", execResult);
			return;
		}
		case "listMcpResourcesExecArgs": {
			const execResult = create(ListMcpResourcesExecResultSchema, {});
			sendExecClientMessage(h2Request, execMsg, "listMcpResourcesExecResult", execResult);
			return;
		}
		case "readMcpResourceExecArgs": {
			const execResult = create(ReadMcpResourceExecResultSchema, {});
			sendExecClientMessage(h2Request, execMsg, "readMcpResourceExecResult", execResult);
			return;
		}
		case "recordScreenArgs": {
			const execResult = create(RecordScreenResultSchema, {});
			sendExecClientMessage(h2Request, execMsg, "recordScreenResult", execResult);
			return;
		}
		case "computerUseArgs": {
			const execResult = create(ComputerUseResultSchema, {});
			sendExecClientMessage(h2Request, execMsg, "computerUseResult", execResult);
			return;
		}
		default: {
			log("warn", "unhandledExecMessage", { execCase });
			// Send a bare ExecClientMessage (id + execId only, no typed result) so the
			// server gets an acknowledgement and doesn't hang waiting forever.
			const ack = create(ExecClientMessageSchema, {
				id: execMsg.id,
				execId: execMsg.execId,
			});
			const clientMessage = create(AgentClientMessageSchema, {
				message: { case: "execClientMessage", value: ack },
			});
			h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
		}
	}
}

function sendExecClientMessage<C extends NonNullable<ExecClientMessage["message"]["case"]>>(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	messageCase: C,
	value: Extract<ExecClientMessage["message"], { case: C }>["value"],
): void {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execMsg.id,
		execId: execMsg.execId,
		// The generic correlates case and value at every call site; the union
		// member itself cannot be proven pairwise by TS, hence the assertion.
		message: { case: messageCase, value } as ExecClientMessage["message"],
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientMessage", value: execClientMessage },
	});

	const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
	h2Request.write(frameConnectMessage(responseBytes));

	log("execClientMessage", messageCase, value);
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
				if (!file || Number.isNaN(count)) {
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
			// A line is context only when it did NOT parse as a real match. The two
			// regexes overlap: a genuine match line whose content contains a
			// `-<digits>-` run (an ISO date like 2024-01-15, an index like x-1-y)
			// ALSO satisfies the context pattern, so `Boolean(contextLine)` would
			// mislabel that match as context and drop it from totalMatchedLines.
			// `match` already prefers matchLine, so derive the flag from matchLine.
			const isContextLine = matchLine === null;
			const list = matchMap.get(file) ?? [];
			list.push({ line: Number(lineNumber), content, isContextLine });
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
 * the task tool's `tasks` array on multi-subagent dispatches, issue #2615).
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

/** Exported for tests: drives one Cursor interaction update through the streaming state machine. */
export function processInteractionUpdate(
	update: InteractionUpdateView,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const updateCase = update.message?.case;
	const value = update.message?.value ?? {};

	log("interactionUpdate", updateCase, update.message?.value);

	if (updateCase === "textDelta") {
		state.setFirstTokenTime();
		const delta = value.text || "";
		if (!state.currentTextBlock) {
			const block: TextContent & { [kStreamingBlockIndex]: number } = {
				type: "text",
				text: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentTextBlock!.text += delta;
		const idx = output.content.indexOf(state.currentTextBlock!);
		stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingDelta") {
		state.setFirstTokenTime();
		const delta = value.text || "";
		if (!state.currentThinkingBlock) {
			const block: ThinkingContent & { [kStreamingBlockIndex]: number } = {
				type: "thinking",
				thinking: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setThinkingBlock(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentThinkingBlock!.thinking += delta;
		const idx = output.content.indexOf(state.currentThinkingBlock!);
		stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingCompleted") {
		endCurrentThinkingBlock(output, stream, state);
	} else if (updateCase === "toolCallStarted") {
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const toolCall = value.toolCall;
		if (toolCall) {
			const mcpCall = mcpToolCallOf(toolCall);
			if (mcpCall) {
				const args = mcpCall.args || {};
				const block: ToolCallState = {
					type: "toolCall",
					id: args.toolCallId || crypto.randomUUID(),
					name: args.name || args.toolName || "",
					arguments: {},
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingPartialJson]: "",
					[kStreamingBlockKind]: "mcp",
				};
				output.content.push(block);
				state.setToolCall(block);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				return;
			}

			const todoArgs = buildTodoArgs(toolCall);
			if (todoArgs) {
				const callId = value.callId || crypto.randomUUID();
				const block: ToolCallState = {
					type: "toolCall",
					id: callId,
					name: "todo",
					arguments: todoArgs,
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingBlockKind]: "todo",
				};
				output.content.push(block);
				state.setToolCall(block);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			}
		}
	} else if (updateCase === "toolCallDelta" || updateCase === "partialToolCall") {
		if (state.currentToolCall?.[kStreamingBlockKind] === "mcp") {
			// Cursor's `args_text_delta` is "aggregated args text so far" per agent.proto: each
			// delta is a cumulative snapshot of the JSON-text args. Strip the prefix we already
			// have to recover the new suffix; fall back to treating the value as an incremental
			// fragment when it doesn't extend the buffer.
			const snapshot: string = value.argsTextDelta || "";
			const current = state.currentToolCall[kStreamingPartialJson] ?? "";
			const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
			if (chunk.length === 0) {
				return;
			}
			const nextBuffer = current + chunk;
			state.currentToolCall[kStreamingPartialJson] = nextBuffer;
			// Throttle mid-stream parses to keep total parse work O(N) instead of O(N²)
			// in the argument-buffer length; the authoritative full parse runs in
			// `toolCallCompleted` (mcp branch) and the fallback end-of-stream path.
			const throttled = parseStreamingJsonThrottled(nextBuffer, state.currentToolCall[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				state.currentToolCall.arguments = throttled.value;
				state.currentToolCall[kStreamingLastParseLen] = throttled.parsedLen;
			}
			const idx = output.content.indexOf(state.currentToolCall);
			stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: output });
		}
	} else if (updateCase === "toolCallCompleted") {
		if (state.currentToolCall) {
			const toolCall = value.toolCall;
			if (state.currentToolCall[kStreamingBlockKind] === "mcp") {
				// Authoritative full parse of the accumulated argument buffer; the delta
				// path throttles mid-stream parses, so `arguments` may lag the buffer.
				const partial = state.currentToolCall[kStreamingPartialJson];
				if (partial !== undefined) {
					state.currentToolCall.arguments = parseStreamingJson(partial);
				}
				const decodedArgs = decodeMcpArgsMap(toolCall ? mcpToolCallOf(toolCall)?.args?.args : undefined);
				state.currentToolCall.arguments = mergeCursorMcpToolCallArgs(
					state.currentToolCall.arguments as Record<string, unknown> | undefined,
					decodedArgs,
				);
			} else if (state.currentToolCall[kStreamingBlockKind] === "todo" && toolCall) {
				const todoArgs = buildTodoArgs(toolCall);
				if (todoArgs) {
					state.currentToolCall.arguments = todoArgs;
				}
			}
			const idx = output.content.indexOf(state.currentToolCall);
			clearStreamingPartialJson(state.currentToolCall);
			stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: state.currentToolCall, partial: output });
			state.setToolCall(null);
		}
	} else if (updateCase === "tokenDelta") {
		// `turnEnded` is deliberately not handled here. It is the turn's only
		// completion signal and `streamCursor` owns it, because a turn that never
		// receives one did not finish and must not report that it did.
		state.usage.completionTokens += value.tokens || 0;
		state.usage.fold();
	}
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
 * Build one Cursor system-message JSON blob per ordered system prompt. Emitting separate blobs
 * (rather than a single `\n\n`-joined string) lets Cursor's blob cache hit independently per
 * entry: changing only the last prompt does not invalidate earlier blob ids, so the prefix
 * up to the changed prompt remains cached on the server side.
 *
 * When no system prompts are provided, returns a single default greeting so we never emit
 * an empty `rootPromptMessagesJson` head.
 */
export function buildCursorSystemPromptJsons(systemPrompt: readonly string[] | undefined): string[] {
	const systemPrompts = normalizeSystemPrompts(systemPrompt);
	if (systemPrompts.length === 0) {
		return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
	}
	return systemPrompts.map(content => JSON.stringify({ role: "system", content }));
}

/**
 * `full_path` of the rule that carries the session system prompt. `CursorRule.full_path`
 * is documented as the absolute path of the rule's file, but the system prompt is
 * compiled, not file-backed, so it gets a stable scheme path instead: it cannot collide
 * with a real workspace file and reads as provenance wherever the server renders it.
 */
const CURSOR_SYSTEM_PROMPT_RULE_PATH = "veyyon://system-prompt.mdc";

function createCursorRule(fullPath: string, content: string): CursorRule {
	return create(CursorRuleSchema, {
		fullPath,
		content,
		// `global` (always-apply) with the default source is what cursor-agent itself sends
		// for AGENTS.md and .cursorrules: operator-level instructions, one rule per source.
		// Verified against the cursor-agent bundle, whose AGENTS.md walk builds exactly
		// this shape with the file's real absolute path.
		type: create(CursorRuleTypeSchema, { type: { case: "global", value: create(CursorRuleTypeGlobalSchema, {}) } }),
		source: 0,
	});
}

/**
 * Compose the `requestContext.rules` payload: the session system prompt as one rule,
 * followed by the caller-supplied file units in caller order (the coding-agent hands
 * them over in ascending authority, so the operator's global file keeps the last,
 * highest-recency slot, same as in the prompt).
 *
 * Rules are Cursor's only honored client-instruction channel: the system-prompt blobs
 * at the `rootPromptMessagesJson` head are fetched and then replaced by the server's
 * own prompt (wire capture, 2026-08), so without this the model runs with none of the
 * caller's instructions. One rule per unit, not one joined blob, so the server's
 * content-keyed rule cache stays warm for every file that did not change.
 *
 * Exported for tests.
 */
export function buildCursorRules(
	systemPrompt: readonly string[] | undefined,
	inputRules: readonly CursorRuleInput[] | undefined,
): CursorRule[] {
	const rules: CursorRule[] = [];
	const systemPrompts = normalizeSystemPrompts(systemPrompt);
	if (systemPrompts.length > 0) {
		rules.push(createCursorRule(CURSOR_SYSTEM_PROMPT_RULE_PATH, systemPrompts.join("\n\n")));
	}
	for (const input of inputRules ?? []) {
		// An empty file is no instruction. cursor-agent skips empty AGENTS.md the same way.
		if (input.content.trim().length === 0) continue;
		rules.push(createCursorRule(input.fullPath, input.content));
	}
	return rules;
}

function buildRootPromptMessagesJson(
	messages: Message[],
	systemPromptIds: Uint8Array[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): Uint8Array[] {
	const entries: Uint8Array[] = [...systemPromptIds];
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

async function buildGrpcRequest(
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

	const systemPromptJsons = buildCursorSystemPromptJsons(context.systemPrompt);
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

	const replacementPayload = await options?.onPayload?.(runRequest, model);
	if (replacementPayload !== undefined) {
		runRequest = replacementPayload as AgentRunRequest;
	}

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});

	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);

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
