import { createHash } from "node:crypto";
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
import { logger } from "@veyyon/utils";
import { $env } from "@veyyon/utils/env";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
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
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { toolWireSchema } from "../utils/schema/wire";

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
	debugReplacer,
	decodeMcpArgValue,
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

export type ToolCallState = ToolCall & {
	[kStreamingBlockIndex]: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingBlockKind]: "mcp" | "todo" | "cursor-exec";
	[kCursorExecResolved]?: true;
};

export interface CursorUsageAccount {
	completionTokens: number;
	conversationTokens: number;
	contextWindow: number;
	contextComposition: ProviderContextBucket[] | undefined;
	fold: () => void;
}

export function createCursorUsageAccount(model: Model<"cursor-agent">, output: AssistantMessage): CursorUsageAccount {
	const account: CursorUsageAccount = {
		completionTokens: 0,
		conversationTokens: 0,
		contextWindow: 0,
		contextComposition: undefined,
		fold: () => {
			output.usage.output = account.completionTokens;
			output.usage.input = Math.max(0, account.conversationTokens - account.completionTokens);
			output.usage.totalTokens = output.usage.input + output.usage.output;
			if (account.contextWindow > 0) {
				output.providerContextWindow = account.contextWindow;
			}
			output.providerContextComposition = account.contextComposition;

			calculateCost(model, output.usage);
		},
	};
	return account;
}

export interface BlockState {
	currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null;
	currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null;
	currentToolCall: ToolCallState | null;
	execDispatchedToolCalls: Set<string>;
	firstTokenTime: number | undefined;
	usage: CursorUsageAccount;
	setTextBlock: (b: (TextContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setThinkingBlock: (b: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setToolCall: (t: ToolCallState | null) => void;
	setFirstTokenTime: () => void;
}

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
		processInteractionUpdate(msg.message.value as InteractionUpdateView, output, stream, state);
	} else if (msgCase === "kvServerMessage") {
		handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request, delivery);
	} else if (msgCase === "execServerMessage") {
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

interface CursorTurnDelivery {
	systemPromptBlobIds: ReadonlySet<string>;
	onFatal: (error: Error) => void;
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

		if (!blobData) {
			const isSystemPrompt = lookup?.systemPromptBlobIds.has(blobIdKey) === true;
			logger.warn(
				isSystemPrompt
					? "Cursor asked for a system-prompt blob this process does not hold; the model would have run with no system prompt"
					: "Cursor asked for a blob this process does not hold; that part of the conversation is missing from the prompt",
				{ blobId: blobIdKey, systemPrompt: isSystemPrompt, knownBlobs: blobStore.size },
			);
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

	const sendBufferedOutput = !streamHandler;
	const sanitizedExecResult = sanitizeShellExecResult(execResult);

	if (stdoutFlushTimer) clearTimeout(stdoutFlushTimer);
	if (stderrFlushTimer) clearTimeout(stderrFlushTimer);
	flushStdout();
	flushStderr();

	sendShellStreamExitFromResult(h2Request, execMsg, sanitizedExecResult, sendBufferedOutput);

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
		delivery?.onRequestContextDelivered?.();
		log("execClient", "requestContextResult", {
			rules: requestContextRules.map(rule => ({
				fullPath: rule.fullPath,
				bytes: Buffer.byteLength(rule.content, "utf8"),
			})),
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
			const emptyPatternError = emptyGrepPatternRejection(args.pattern, args.glob);
			if (emptyPatternError !== null) {
				sendExecClientMessage(h2Request, execMsg, "grepResult", buildGrepErrorResult(emptyPatternError));
				return;
			}
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
			markCursorExecDispatched(mcpCall.toolCallId, output, state);
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

function markCursorExecDispatched(toolCallId: string, output: AssistantMessage, state: BlockState): void {
	if (!toolCallId) return;
	state.execDispatchedToolCalls.add(toolCallId);
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

export interface InteractionUpdateView {
	message?: {
		case?: string;
		value?: {
			text?: string;
			toolCall?: CursorToolCallView;
			callId?: string;
			argsTextDelta?: string;
			tokens?: number;
		};
	};
}

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
				const toolCallId = args.toolCallId || crypto.randomUUID();
				const block: ToolCallState = {
					type: "toolCall",
					id: toolCallId,
					name: args.name || args.toolName || "",
					arguments: {},
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingPartialJson]: "",
					[kStreamingBlockKind]: "mcp",
					...(state.execDispatchedToolCalls.has(toolCallId) ? { [kCursorExecResolved]: true } : {}),
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
			// Cumulative args JSON snapshot (not incremental delta).
			const snapshot: string = value.argsTextDelta || "";
			const current = state.currentToolCall[kStreamingPartialJson] ?? "";
			const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
			if (chunk.length === 0) {
				return;
			}
			const nextBuffer = current + chunk;
			state.currentToolCall[kStreamingPartialJson] = nextBuffer;
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
		state.usage.completionTokens += value.tokens || 0;
		state.usage.fold();
	}
}

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

export function handleConversationCheckpointUpdate(
	checkpoint: ConversationStateStructure,
	usage: CursorUsageAccount,
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): void {
	onConversationCheckpoint?.(checkpoint);
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

function extractAssistantMessageText(msg: Message): string {
	if (msg.role !== "assistant") return "";
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function findLastUserMessageIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i].role;
		if (role === "user" || role === "developer") {
			return i;
		}
	}
	return -1;
}

export function buildCursorSystemPromptJsons(systemPrompt: readonly string[] | undefined): string[] {
	const systemPrompts = normalizeSystemPrompts(systemPrompt);
	if (systemPrompts.length === 0) {
		return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
	}
	return systemPrompts.map(content => JSON.stringify({ role: "system", content }));
}

const CURSOR_SYSTEM_PROMPT_RULE_PATH = "veyyon://system-prompt.mdc";

function createCursorRule(fullPath: string, content: string): CursorRule {
	return create(CursorRuleSchema, {
		fullPath,
		content,
		type: create(CursorRuleTypeSchema, { type: { case: "global", value: create(CursorRuleTypeGlobalSchema, {}) } }),
		source: 0,
	});
}

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

function buildConversationTurns(
	messages: Message[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): Uint8Array[] {
	const turns: Uint8Array[] = [];

	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role !== "user" && msg.role !== "developer") {
			i++;
			continue;
		}

		if (i === activeUserMessageIndex) {
			break;
		}

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

	const turns = buildConversationTurns(context.messages, blobStore, activeUserMessage ? activeUserMessageIndex : -1);

	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		context.messages,
		systemPromptIds,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
	);

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

	const conversationState = create(ConversationStateStructureSchema, {
		...baseState,
		rootPromptMessagesJson,
		turns,
	});

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

	if (options?.customSystemPrompt) {
		runRequest.customSystemPrompt = options.customSystemPrompt;
	}

	const payloadHook = options?.onPayload;
	if (payloadHook) {
		const replacementPayload = await payloadHook(toJson(AgentRunRequestSchema, runRequest), model);
		if (replacementPayload !== undefined) {
			runRequest = fromJson(AgentRunRequestSchema, replacementPayload as JsonValue);
		}
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
