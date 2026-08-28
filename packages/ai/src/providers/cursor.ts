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
import { logger } from "@veyyon/utils";
import { parseStreamingJson } from "@veyyon/utils/json-parse";
import { errorMessage } from "@veyyon/utils/type-guards";
import * as AIError from "../error";
import type { Api, AssistantMessage, Context, Model, StreamFunction, TextContent, ThinkingContent } from "../types";
import { clearStreamingPartialJson, kStreamingBlockIndex, kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";

import {
	CONNECT_END_STREAM_FLAG,
	CURSOR_API_URL,
	CURSOR_CLIENT_VERSION,
	CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
	type CursorOptions,
	conversationBlobStores,
	conversationRulesDelivered,
	conversationStateCache,
	cursorRulesFingerprint,
	cursorStreamFailure,
	frameConnectMessage,
	log,
	MAX_CONNECT_FRAME_PAYLOAD,
	parseConnectEndStream,
} from "./cursor-helpers";

export {
	BoundedLruMap,
	CURSOR_API_URL,
	CURSOR_CLIENT_VERSION,
	type CursorOptions,
	cursorStreamFailure,
	parseConnectEndStream,
} from "./cursor-helpers";

import {
	type BlockState,
	buildCursorRules,
	buildGrpcRequest,
	buildMcpToolDefinitions,
	createCursorUsageAccount,
	endCurrentTextBlock,
	endCurrentThinkingBlock,
	handleServerMessage,
	type ToolCallState,
} from "./cursor-helpers";

export {
	type BlockState,
	buildCursorHistoryForTest,
	buildCursorRules,
	buildCursorSystemPromptJsons,
	buildGrepResultFromToolResult,
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

			const { promise: h2Promise, resolve: resolveH2, reject: rejectH2 } = Promise.withResolvers<void>();

			h2Request = h2Client.request(requestHeaders);
			stream.push({ type: "start", partial: output });

			let pendingBuffer = Buffer.alloc(0);
			let endStreamError: Error | null = null;
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
			let turnCompleted = false;
			let requestContextDelivered = false;
			let refusedStatus: number | undefined;
			let refusalBody = "";

			const REFUSAL_BODY_LIMIT = 8 * 1024;
			const pendingMessagePromises = new Set<Promise<void>>();

			const closeDebugLog = async (): Promise<void> => {
				try {
					const log = await debugResponseLogPromise;
					await log?.close();
				} catch {}
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
								requestContextRules,
								onConversationCheckpoint,
								{
									systemPromptBlobIds,
									onFatal: failTurn,
									onRequestContextDelivered: () => {
										requestContextDelivered = true;
									},
								},
							);
						})();

						pendingMessagePromises.add(messagePromise);

						messagePromise
							.catch(error => {
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

						if (isTurnEnded) {
							turnCompleted = true;
							void Promise.allSettled(Array.from(pendingMessagePromises)).then(async () => {
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
				} catch {}
			};

			heartbeatTimer = setInterval(sendHeartbeat, 5000);

			h2Request.on("trailers", trailers => {
				const status = trailers["grpc-status"];
				const rawMsg = String(trailers["grpc-message"] || "");
				let msg = rawMsg;
				try {
					msg = decodeURIComponent(rawMsg);
				} catch {}
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
					} catch {}
					try {
						if (h2Client && !h2Client.closed && !h2Client.destroyed) {
							h2Client.close();
						}
					} catch {}
					terminateStream(() => rejectH2(new AIError.RequestAbortError()));
				};

				if (abortSignal.aborted) abortHandler();
				else abortSignal.addEventListener("abort", abortHandler, { once: true });
			}

			await h2Promise;

			if (!turnCompleted) {
				throw new AIError.ProviderResponseError(
					"Cursor stream ended without a turn_ended update (connection dropped or response truncated)",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}

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
			try {
				const log = await debugResponseLogPromise;
				await log?.close();
			} catch {}
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			try {
				h2Request?.close();
			} catch {}
			try {
				h2Client?.close();
			} catch {}

			if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
		}
	})();

	return stream;
};
