import * as fs from "node:fs/promises";
import http2 from "node:http2";
import { setImmediate as yieldToProtocolEvents } from "node:timers/promises";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ClientHeartbeatSchema,
	type ConversationStateStructure,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { emptyUsage } from "@veyyon/catalog/models";
import { CURSOR_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { logger } from "@veyyon/utils";
import { $env } from "@veyyon/utils/env";
import { parseStreamingJson } from "@veyyon/utils/json-parse";
import { errorMessage } from "@veyyon/utils/type-guards";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	CursorExecHandlers,
	CursorToolResultHandler,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
} from "../types";
import { clearStreamingPartialJson, kStreamingBlockIndex, kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";

/**
 * Cursor's API host.
 *
 * Re-exported from `@veyyon/catalog/provider-endpoints`, which owns it, rather than declared here: this
 * package's usage reader and `catalog`'s discovery reader both need the same fallback, and this name is the
 * one callers already import.
 */

import {
	type BlockState,
	buildGrpcRequest,
	buildMcpToolDefinitions,
	createCursorUsageAccount,
	decodeMcpArgValue,
	endCurrentTextBlock,
	endCurrentThinkingBlock,
	handleServerMessage,
	openToolCallBlocks,
	type ToolCallState,
} from "./cursor-helpers";

export {
	type BlockState,
	buildCursorHistoryForTest,
	buildCursorSystemPromptJsons,
	buildGrepResultFromToolResult,
	buildGrpcRequest,
	type CursorUsageAccount,
	createCursorUsageAccount,
	emptyGrepPatternRejection,
	handleConversationCheckpointUpdate,
	handleServerMessage,
	type InteractionUpdateView,
	mergeCursorMcpToolCallArgs,
	processInteractionUpdate,
	resolveExecHandler,
	synthesizeCursorExecToolCall,
	type ToolCallState,
} from "./cursor-helpers";

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

export interface CursorOptions extends StreamOptions {
	customSystemPrompt?: string;
	execHandlers?: CursorExecHandlers;
	onToolResult?: CursorToolResultHandler;
	/** Wire model uid selected after thinking-effort routing (see mapOptionsForApi). */
	wireModelId?: string;
}

const CONNECT_END_STREAM_FLAG = 0b00000010;

/**
 * Hard upper bound on a single Connect frame payload in Cursor streams. The 4-byte length prefix
 * is otherwise attacker-controlled (up to `2**32 - 1`), so a corrupt length prefix fails fast
 * instead of buffering indefinitely until memory exhaustion or watchdog timeout.
 */
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

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

export function log(type: string, subtype?: string, data?: unknown): void {
	if (!$env.DEBUG_CURSOR) return;
	const normalizedData = data ? decodeLogData(data) : data;
	const entry: CursorLogEntry = { ts: Date.now(), type, subtype, data: normalizedData };
	const verbose = $env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose";
	const dataStr = verbose && normalizedData ? ` ${JSON.stringify(normalizedData, debugReplacer)?.slice(0, 500)}` : "";
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
	void appendCursorDebugLog(entry);
}

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
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

export function debugReplacer(key: string, value: unknown): unknown {
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
			if (options?.signal?.aborted) {
				throw new AIError.RequestAbortError();
			}

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

			const { promise: h2Promise, resolve: resolveH2, reject: rejectH2 } = Promise.withResolvers<void>();

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
				execDispatchedToolCalls: new Set<string>(),
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

			let streamTerminated = false;
			// `turnEnded` is the only thing that says the server finished this turn.
			// The h2 stream also ends when the connection simply stops, and those two
			// are not the same event.
			let turnCompleted = false;
			// A gateway that refuses answers with an HTTP status and a body, not
			// with Connect frames. The status arrived at the handler below and was
			// read only for the debug log, so a `401`, a `429` or a proxy's error
			// page reached the operator as "stream ended without a turn_ended
			// update": the one class of failure whose remedy belongs to the person
			// at the keyboard, reported as a truncated stream. A refusal body is
			// collected instead of frame-parsed — it carries no Connect framing —
			// and the shared bound names it.
			let refusedStatus: number | undefined;
			let refusalBody = "";
			// Enough for any error envelope, and a bound against a proxy that
			// answers a megabyte of HTML.
			const REFUSAL_BODY_LIMIT = 8 * 1024;
			const pendingMessagePromises = new Set<Promise<void>>();

			const closeDebugLog = async (): Promise<void> => {
				try {
					const log = await debugResponseLogPromise;
					await log?.close();
				} catch {
					// Ignore debug log close failure so logging never masks the turn result
				}
			};

			const terminateStream = (reason?: () => void) => {
				if (streamTerminated) return;
				streamTerminated = true;
				void (async () => {
					if (pendingMessagePromises.size > 0) {
						await Promise.allSettled(Array.from(pendingMessagePromises));
					}
					await closeDebugLog();
					if (refusedStatus !== undefined) {
						// The status is the remedy: 401 is a credential, 429 is a
						// wait, 404 is the route. `CursorApiError` carries it, so
						// the shared classifier reads the same retry decision it
						// reads for every other provider's HTTP refusal.
						rejectH2(
							new AIError.CursorApiError(
								`Cursor API error ${refusedStatus}: ${AIError.boundProviderErrorDetail(refusalBody)}`,
								refusedStatus,
							),
						);
						return;
					}
					if (endStreamError) {
						rejectH2(endStreamError);
						return;
					}
					if (reason) {
						reason();
						return;
					}
					if (turnCompleted) {
						resolveH2();
						return;
					}
					rejectH2(
						new AIError.ProviderResponseError(
							"Cursor stream ended without a turn_ended update (connection dropped or response truncated)",
							{ provider: model.provider, kind: "incomplete-stream" },
						),
					);
				})().catch(err => rejectH2(err));
			};

			h2Request.on("response", headers => {
				const status = Number(headers[":status"]);
				if (Number.isFinite(status) && status >= 400) refusedStatus = status;
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
				if (refusedStatus !== undefined) {
					if (refusalBody.length < REFUSAL_BODY_LIMIT) refusalBody += chunk.toString("utf8");
					return;
				}
				pendingBuffer = Buffer.concat([pendingBuffer, chunk]);

				while (pendingBuffer.length >= 5) {
					const flags = pendingBuffer[0];
					const msgLen = pendingBuffer.readUInt32BE(1);
					if (msgLen > MAX_CONNECT_FRAME_PAYLOAD) {
						failTurn(
							new AIError.ProviderResponseError(
								`Cursor Connect frame length ${msgLen} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
								{ provider: model.provider, kind: "envelope" },
							),
						);
						break;
					}
					if (pendingBuffer.length < 5 + msgLen) break;

					const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
					pendingBuffer = pendingBuffer.subarray(5 + msgLen);

					if (flags & CONNECT_END_STREAM_FLAG) {
						const endError = parseConnectEndStream(messageBytes);
						if (endError) {
							failTurn(endError);
						}
						continue;
					}

					try {
						const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
						const isTurnEnded =
							serverMessage.message.case === "interactionUpdate" &&
							serverMessage.message.value.message?.case === "turnEnded";

						const messagePromise = (async () => {
							await handleServerMessage(
								serverMessage,
								output,
								stream,
								state,
								blobStore,
								h2Request!,
								options?.execHandlers,
								options?.onToolResult,
								requestContextTools,
								onConversationCheckpoint,
								{
									systemPromptBlobIds,
									onFatal: failTurn,
								},
							);
						})();

						pendingMessagePromises.add(messagePromise);

						messagePromise
							.catch(error => {
								// `log` is a no-op unless DEBUG_CURSOR is set, so every failure inside a server-message
								// handler used to vanish: an exec handler that threw, a malformed interaction update, a
								// checkpoint that could not be applied. The turn then completed as though nothing had
								// gone wrong. Report it and fail the turn immediately so the client does not wait for a watchdog.
								logger.warn("Cursor server message handler failed", {
									model: model.id,
									messageCase: serverMessage.message.case,
									error: errorMessage(error),
								});
								failTurn(error instanceof Error ? error : new Error(String(error)));
							})
							.finally(() => {
								pendingMessagePromises.delete(messagePromise);
							});

						// The one place the turn is declared over. Both the resolve and the
						// completion check below read this, so there is no second opinion.
						// Await all in-flight server message handlers before resolving so
						// turnEnded arriving while an exec handler is pending cannot emit
						// false success or orphan the handler.
						if (isTurnEnded) {
							turnCompleted = true;
							void Promise.allSettled(Array.from(pendingMessagePromises)).then(async () => {
								// Give already-arrived protocol terminal events (e.g. HTTP/2 trailers)
								// one event-loop turn to be dispatched and set endStreamError before resolving success.
								await yieldToProtocolEvents();
								terminateStream();
							});
						}
					} catch (e) {
						log("error", "parseServerMessage", { error: String(e) });
						failTurn(e instanceof Error ? e : new Error(String(e)));
						break;
					}
				}
			});

			h2Request.write(frameConnectMessage(requestBytes));

			const sendHeartbeat = () => {
				if (!h2Request || h2Request.closed || h2Request.destroyed) {
					return;
				}
				try {
					const heartbeatMessage = create(AgentClientMessageSchema, {
						message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
					});
					const heartbeatBytes = toBinary(AgentClientMessageSchema, heartbeatMessage);
					h2Request.write(frameConnectMessage(heartbeatBytes));
				} catch {
					// Ignore heartbeat write failures on closing streams
				}
			};

			heartbeatTimer = setInterval(sendHeartbeat, 5000);

			h2Request.on("trailers", trailers => {
				const status = trailers["grpc-status"];
				const rawMsg = String(trailers["grpc-message"] || "");
				let msg = rawMsg;
				try {
					msg = decodeURIComponent(rawMsg);
				} catch {
					// Malformed percent-encoding in grpc-message should not crash event handler
				}
				if (status && status !== "0") {
					failTurn(cursorStreamFailure(String(status), msg, "gRPC error"));
				}
			});

			h2Request.on("end", () => {
				terminateStream();
			});

			h2Request.on("close", () => {
				terminateStream();
			});

			h2Request.on("error", (error: Error) => {
				terminateStream(() => rejectH2(error));
			});

			h2Client.on("error", (error: Error) => {
				terminateStream(() => rejectH2(error));
			});

			h2Client.on("close", () => {
				terminateStream();
			});

			if (abortSignal) {
				abortHandler = () => {
					try {
						h2Request?.close();
					} catch {
						// Ignore close errors
					}
					try {
						if (h2Client && !h2Client.closed && !h2Client.destroyed) {
							h2Client.close();
						}
					} catch {
						// Ignore close errors
					}
					terminateStream(() => rejectH2(new AIError.RequestAbortError()));
				};
				// Already aborted before we attached: the event will never fire, so
				// run the handler once synchronously instead of hanging the round.
				if (abortSignal.aborted) abortHandler();
				// { once: true } auto-detaches if it fires; the finally detaches it
				// on every normal completion so it never outlives this one round.
				else abortSignal.addEventListener("abort", abortHandler, { once: true });
			}

			await h2Promise;

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

			endCurrentTextBlock(output, stream, state);
			endCurrentThinkingBlock(output, stream, state);
			// Every call the turn opened and never completed, not only the last
			// one: a batch completes out of pointer order, so closing "the current
			// tool call" left every earlier call of the batch without a
			// `toolcall_end`, and the loop then treated a call whose arguments had
			// fully arrived as one that never finished streaming.
			for (const open of openToolCallBlocks(output)) {
				const idx = output.content.indexOf(open);
				const partial = open[kStreamingPartialJson];
				if (partial) open.arguments = parseStreamingJson(partial);
				clearStreamingPartialJson(open);
				stream.push({
					type: "toolcall_end",
					contentIndex: idx,
					toolCall: open,
					partial: output,
				});
			}
			state.setToolCall(null);

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
			try {
				const log = await debugResponseLogPromise;
				await log?.close();
			} catch {
				// Ignore debug log close failure
			}
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			try {
				h2Request?.close();
			} catch {
				// Ignore close errors
			}
			try {
				h2Client?.close();
			} catch {
				// Ignore close errors
			}
			// Detach the abort listener so it cannot outlive this round on the
			// shared run signal (removeEventListener is a no-op if it already fired).
			if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
		}
	})();

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
