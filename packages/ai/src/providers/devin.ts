import { scheduler } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import {
	DEVIN_EXTENSION_NAME,
	DEVIN_EXTENSION_VERSION,
	DEVIN_IDE_NAME,
	DEVIN_IDE_VERSION,
	normalizeDevinSessionToken,
} from "@veyyon/catalog/discovery/devin";
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	PromptCacheOptionsSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/chat_pb/chat_pb";
import {
	ChatMessageSource,
	type ChatToolCall,
	ChatToolCallSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	ImageDataSchema,
	MetadataSchema,
	StopReason,
} from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { calculateCost, discardAttemptUsage, emptyUsage } from "@veyyon/catalog/models";
import { DEVIN_CASCADE_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { isAbortError } from "@veyyon/utils/abortable";
import { tryParseJson } from "@veyyon/utils/json";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { clearStreamingPartialJson, setStreamingPartialJson } from "../utils/block-symbols";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";

/** Base host for Codeium/Windsurf's Cascade chat API (Connect protocol over HTTP/1.1). */
export { DEVIN_CASCADE_ENDPOINT } from "@veyyon/catalog/provider-endpoints";

export interface DevinOptions extends StreamOptions {
	/** Wire model uid selected after thinking-effort routing. */
	chatModelUid?: string;
	/** Internal provider-level retry attempt counter. */
	devinRetryAttempt?: number;
}

/** Maximum provider-level retry attempts before erroring. */
const DEVIN_MAX_PROVIDER_RETRIES = 3;
const DEVIN_RETRY_BASE_DELAY_MS = 1_000;
/** Maximum wait duration for server-requested rate limit resets (90s). */
const DEVIN_RETRY_MAX_DELAY_MS = 90_000;

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

/** Connect streaming framing: flag byte bit 0x01 = gzip payload, 0x02 = end-of-stream JSON trailers. */
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
/** Maximum Connect frame payload size (16 MiB). */
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export const streamDevin: StreamFunction<"devin-agent"> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: DevinOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	const retryAttempt = options?.devinRetryAttempt ?? 0;

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "devin-agent" as Api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let currentTextBlock: TextContent | null = null;
		let currentThinkingBlock: ThinkingContent | null = null;
		const toolBlocks = new Map<string, ToolCall>();
		const toolPartialJson = new Map<string, string>();
		const toolLastParseLen = new Map<string, number>();
		let activeToolCallId: string | undefined;
		let latestStopReason = StopReason.UNSPECIFIED;

		const markFirstToken = () => {
			if (firstTokenTime === undefined) firstTokenTime = performance.now();
		};

		const endTextBlock = () => {
			const block = currentTextBlock;
			if (!block) return;
			currentTextBlock = null;
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(block),
				content: block.text,
				partial: output,
			});
		};

		const endThinkingBlock = () => {
			const block = currentThinkingBlock;
			if (!block) return;
			currentThinkingBlock = null;
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(block),
				content: block.thinking,
				partial: output,
			});
		};

		try {
			const fetchImpl = options?.fetch ?? fetch;
			const baseUrl = trimTrailingSlashes(model.baseUrl || DEVIN_CASCADE_ENDPOINT);
			const apiKey = normalizeDevinSessionToken(options?.apiKey);
			const auth = await fetchDevinAuthMetadata(apiKey, baseUrl, fetchImpl, options?.signal);
			const chatBaseUrl = auth.baseUrl ?? baseUrl;
			let request = buildDevinChatRequest(model, context, options, apiKey, auth.userJwt);
			logger.debug("devin: sending chat request", { model: model.id, tools: context.tools?.length ?? 0 });
			const resolvedApiKey = request.metadata?.apiKey ?? apiKey;
			const resolvedUserJwt = request.metadata?.userJwt ?? auth.userJwt;

			// Redact proto3 JSON via onPayload hook when configured.
			const payloadHook = options?.onPayload;
			if (payloadHook) {
				const replacementPayload = await payloadHook(toJson(GetChatMessageRequestSchema, request), model);
				if (replacementPayload !== undefined) {
					request = fromJson(GetChatMessageRequestSchema, replacementPayload as JsonValue);
				}
			}
			const wireMetadata = create(MetadataSchema, request.metadata);
			wireMetadata.apiKey = resolvedApiKey;
			wireMetadata.userJwt = resolvedUserJwt;
			request.metadata = wireMetadata;
			const reqBytes = toBinary(GetChatMessageRequestSchema, request);
			const gz = gzipSync(reqBytes);
			const frame = Buffer.alloc(5 + gz.length);
			frame[0] = CONNECT_COMPRESSED_FLAG;
			frame.writeUInt32BE(gz.length, 1);
			frame.set(gz, 5);

			const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
				method: "POST",
				headers: {
					"content-type": "application/connect+proto",
					"connect-protocol-version": "1",
					"connect-content-encoding": "gzip",
					"accept-encoding": "identity",
					"user-agent": "connect-go/1.18.1 (go1.26.3)",
					"connect-accept-encoding": "gzip",
					...(options?.headers ?? {}),
				},
				body: frame,
				signal: options?.signal,
			});

			if (!response.ok) {
				const detail = await AIError.readProviderErrorDetail(response);
				throw new AIError.DevinApiError(
					`Devin API error ${response.status} ${response.statusText}: ${detail}`,
					response.status,
				);
			}
			if (!response.body) {
				throw new AIError.ProviderResponseError("Devin API error: response body is empty", {
					provider: model.provider,
					kind: "empty-body",
				});
			}
			const body = response.body;

			if (retryAttempt === 0) stream.push({ type: "start", partial: output });

			const reader = body.getReader();
			let pending = Buffer.alloc(0);

			for (;;) {
				const { done, value } = await reader.read();
				if (value && value.length > 0) {
					pending = Buffer.concat([pending, value]);
				}

				while (pending.length >= 5) {
					const flag = pending[0];
					const len = pending.readUInt32BE(1);
					if (len > MAX_CONNECT_FRAME_PAYLOAD) {
						throw new AIError.ProviderResponseError(
							`Devin Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
							{ provider: model.provider, kind: "envelope" },
						);
					}
					if (pending.length < 5 + len) break;
					const payload = pending.subarray(5, 5 + len);
					pending = pending.subarray(5 + len);

					if (flag & CONNECT_END_STREAM_FLAG) {
						const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
						const trailerError = readConnectTrailerError(trailerBytes.toString("utf8").trim());
						if (trailerError) throw devinTrailerFailure(trailerError);
						continue;
					}

					const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
					const msg = fromBinary(GetChatMessageResponseSchema, raw);
					if (msg.messageId && !output.responseId) output.responseId = msg.messageId;

					if (msg.deltaThinking) {
						markFirstToken();
						const block: ThinkingContent = currentThinkingBlock ?? { type: "thinking", thinking: "" };
						if (currentThinkingBlock !== block) {
							output.content.push(block);
							currentThinkingBlock = block;
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						block.thinking += msg.deltaThinking;
						if (msg.deltaSignature) block.thinkingSignature = msg.deltaSignature;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaThinking,
							partial: output,
						});
					}

					if (msg.deltaText) {
						markFirstToken();
						endThinkingBlock();
						const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
						if (currentTextBlock !== block) {
							output.content.push(block);
							currentTextBlock = block;
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						}
						block.text += msg.deltaText;
						stream.push({
							type: "text_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaText,
							partial: output,
						});
					}

					if (msg.deltaToolCalls.length > 0) {
						markFirstToken();
						endTextBlock();
						endThinkingBlock();
						for (const tc of msg.deltaToolCalls) {
							const toolCallId = tc.id || activeToolCallId;
							if (!toolCallId) continue;
							let block = toolBlocks.get(toolCallId);
							if (!block) {
								block = { type: "toolCall", id: toolCallId, name: tc.name, arguments: {} };
								output.content.push(block);
								toolBlocks.set(toolCallId, block);
								toolPartialJson.set(toolCallId, "");
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
							if (tc.name) block.name = tc.name;
							activeToolCallId = toolCallId;
							if (!tc.argumentsJson) continue;
							const previousJson = toolPartialJson.get(toolCallId) ?? "";
							const accumulated = tc.argumentsJson.startsWith(previousJson)
								? tc.argumentsJson
								: previousJson + tc.argumentsJson;
							const delta = accumulated.slice(previousJson.length);
							toolPartialJson.set(toolCallId, accumulated);
							setStreamingPartialJson(block, accumulated);
							const throttled = parseStreamingJsonThrottled(accumulated, toolLastParseLen.get(toolCallId) ?? 0);
							if (throttled) {
								block.arguments = throttled.value;
								toolLastParseLen.set(toolCallId, throttled.parsedLen);
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							});
						}
					}

					if (msg.stopReason !== StopReason.UNSPECIFIED) {
						latestStopReason = msg.stopReason;
					}

					if (msg.usage) {
						output.usage.input = Number(msg.usage.inputTokens);
						output.usage.output = Number(msg.usage.outputTokens);
						output.usage.cacheRead = Number(msg.usage.cacheReadTokens);
						output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens);
						output.usage.totalTokens = output.usage.input + output.usage.output;
					}
				}

				if (done) break;
			}

			endTextBlock();
			endThinkingBlock();
			for (const [id, block] of toolBlocks) {
				block.arguments = parseStreamingJson(toolPartialJson.get(id));
				clearStreamingPartialJson(block);
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(block),
					toolCall: block,
					partial: output,
				});
			}

			const doneReason: "stop" | "length" | "toolUse" =
				toolBlocks.size > 0 ? "toolUse" : latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop";
			output.stopReason = doneReason;

			calculateCost(model, output.usage);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;

			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			const retryDelayMs = devinRetryDelayMs(error, {
				attempt: retryAttempt,
				emittedToken: firstTokenTime !== undefined,
				aborted: options?.signal?.aborted === true,
			});
			if (retryDelayMs !== undefined) {
				logger.warn("devin: transient stream failure, retrying", {
					model: model.id,
					attempt: retryAttempt + 1,
					delayMs: retryDelayMs,
					error: String(error),
				});
				if (options?.providerRetryWait) await options.providerRetryWait(retryDelayMs, options.signal);
				else await scheduler.wait(retryDelayMs, { signal: options?.signal });

				const retried = streamDevin(model, context, { ...options, devinRetryAttempt: retryAttempt + 1 });
				let carried = false;
				const carrySpend = (message: AssistantMessage): AssistantMessage => {
					if (!carried) {
						carried = true;
						discardAttemptUsage(model, output.usage, message.usage);
					}
					return message;
				};
				for await (const event of retried) {
					if (event.type === "done") carrySpend(event.message);
					else if (event.type === "error") carrySpend(event.error);
					stream.push(event);
					if (stream.done) return;
				}
				if (!stream.done) stream.end(carrySpend(await retried.result()));
				return;
			}
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			const record = result.logLevel === "debug" ? logger.debug : logger.error;
			record("devin: stream failed", {
				model: model.id,
				stopReason: result.stopReason,
				status: result.status,
				errorId: result.id,
				rules: result.rules,
				error: String(error),
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: result.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

async function fetchDevinAuthMetadata(
	apiKey: string,
	baseUrl: string,
	fetchImpl: NonNullable<StreamOptions["fetch"]>,
	signal: AbortSignal | undefined,
): Promise<{ userJwt: string; baseUrl?: string }> {
	const request = create(GetUserJwtRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			ideName: DEVIN_IDE_NAME,
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: DEVIN_EXTENSION_NAME,
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
	});
	const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body: toBinary(GetUserJwtRequestSchema, request),
		signal,
	});
	const payload = new Uint8Array(await response.arrayBuffer());
	if (!response.ok) {
		// Through the shared cap like every other interpolated body: an auth endpoint
		// behind a corporate proxy answers with an HTML page, and this was the one site
		// still putting a whole decoded payload into `Error.message`.
		throw new AIError.DevinApiError(
			`Devin auth error ${response.status} ${response.statusText}: ${AIError.boundProviderErrorDetail(new TextDecoder().decode(payload))}`,
			response.status,
		);
	}
	const decoded = decodeDevinUserJwtResponse(payload);
	if (!decoded.userJwt) {
		throw new AIError.ProviderResponseError("Devin auth error: GetUserJwt returned an empty user JWT", {
			provider: "devin",
			kind: "runtime",
		});
	}
	const customBaseUrl = decoded.customApiServerUrl.trim();
	return {
		userJwt: decoded.userJwt,
		...(customBaseUrl ? { baseUrl: trimTrailingSlashes(customBaseUrl) } : undefined),
	};
}

/** Decode GetUserJwt protobuf response (bare or gzipped). */
function decodeDevinUserJwtResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetUserJwtResponseSchema, payload);
	} catch {
		try {
			return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
		} catch {
			throw new AIError.ProviderResponseError(
				`Devin auth error: GetUserJwt answered with ${payload.byteLength} byte(s) that are neither a protobuf response nor gzip: ${AIError.boundProviderErrorDetail(new TextDecoder().decode(payload))}`,
				{ provider: "devin", kind: "envelope" },
			);
		}
	}
}

/** Build GetChatMessageRequest for one Cascade turn. */
function buildDevinChatRequest(
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
	apiKey: string,
	userJwt: string,
) {
	const cascadeId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
	const stopPatterns =
		options?.stopSequences && options.stopSequences.length > 0
			? DEVIN_DEFAULT_STOP_PATTERNS.concat(options.stopSequences)
			: DEVIN_DEFAULT_STOP_PATTERNS;
	return create(GetChatMessageRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			userJwt,
			ideName: DEVIN_IDE_NAME,
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: DEVIN_EXTENSION_NAME,
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
		prompt: (context.systemPrompt ?? []).join("\n\n"),
		chatMessagePrompts: buildChatMessagePrompts(context.messages, cascadeId),
		chatModelUid: options?.chatModelUid ?? model.requestModelId ?? model.id,
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		disableParallelToolCalls: true,
		cascadeId,
		executionId: crypto.randomUUID(),
		configuration: create(CompletionConfigurationSchema, {
			numCompletions: 1n,
			maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
			maxNewlines: 200n,
			temperature: options?.temperature ?? 0.4,
			firstTemperature: options?.temperature ?? 0.4,
			topK: 50n,
			topP: options?.topP ?? 1,
			stopPatterns,
			fimEotProbThreshold: 1,
		}),
		tools: (context.tools ?? []).map((tool: Tool) =>
			create(ChatToolDefinitionSchema, {
				name: tool.name,
				description: tool.description,
				jsonSchemaString: JSON.stringify(toolWireSchema(tool)),
				strict: tool.strict ?? false,
			}),
		),
	});
}

/** Map veyyon `Message` history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM / TOOL channels). */
function buildChatMessagePrompts(messages: Message[], cascadeId: string): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	for (const [index, msg] of messages.entries()) {
		if (msg.role === "user" || msg.role === "developer") {
			let promptText = "";
			const images = [];
			if (typeof msg.content === "string") {
				promptText = msg.content;
			} else {
				for (const part of msg.content) {
					if (part.type === "text") {
						promptText += part.text;
					} else if (part.type === "image") {
						images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
					}
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`),
					source: ChatMessageSource.USER,
					prompt: promptText,
					images,
				}),
			);
		} else if (msg.role === "assistant") {
			let promptText = "";
			let thinkingText = "";
			let signature = "";
			const toolCalls: ChatToolCall[] = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					promptText += part.text;
				} else if (part.type === "thinking") {
					thinkingText += part.thinking;
					if (!signature && part.thinkingSignature) signature = part.thinkingSignature;
				} else if (part.type === "toolCall") {
					toolCalls.push(
						create(ChatToolCallSchema, {
							id: part.id,
							name: part.name,
							argumentsJson: JSON.stringify(part.arguments),
						}),
					);
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: msg.responseId ?? `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
					source: ChatMessageSource.SYSTEM,
					prompt: promptText,
					thinking: thinkingText,
					signature,
					signatureType: "",
					toolCalls,
				}),
			);
		} else {
			let resultText = "";
			const images = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					resultText += part.text;
				} else if (part.type === "image") {
					images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId}`),
					source: ChatMessageSource.TOOL,
					toolCallId: msg.toolCallId,
					toolResultIsError: msg.isError,
					prompt: resultText,
					images,
				}),
			);
		}
	}
	return prompts;
}

/** Stream-level failure reported in Cascade Connect trailer. */
interface DevinTrailerError {
	/** Connect error code, e.g. `resource_exhausted`, `unavailable`, `invalid_argument`. */
	readonly code: string;
	/** The server's human-readable message, which is what carries the rate-limit reset window. */
	readonly message: string;
	/** The operator-facing rendering, unchanged from what this function used to return. */
	readonly text: string;
}

function readConnectTrailerError(text: string): DevinTrailerError | null {
	if (text.length === 0) return null;
	const parsed = tryParseJson(text);
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
	const err = parsed.error;
	if (!err || typeof err !== "object") return null;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (!code && !message) return null;
	return { code, message, text: `Devin stream error${code ? ` ${code}` : ""}: ${message}` };
}

/** Parse rate-limit reset delay in milliseconds from trailer error text. */
export function parseDevinRateLimitResetMs(message: string): number | undefined {
	const match =
		/\breset(?:s)?\s+(?:in|after)\s+(?:about\s+|approximately\s+|~)?(\d+)\s*(second|minute|hour)s?\b/i.exec(message);
	if (!match?.[1] || !match[2]) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = match[2].toLowerCase();
	const scale = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 3_600_000;
	return amount * scale;
}

/** Determine retry delay in milliseconds, or undefined if not retryable. */
function devinRetryDelayMs(
	error: unknown,
	state: { attempt: number; emittedToken: boolean; aborted: boolean },
): number | undefined {
	if (state.aborted || state.emittedToken) return undefined;
	if (state.attempt >= DEVIN_MAX_PROVIDER_RETRIES) return undefined;
	if (isAbortError(error)) return undefined;
	if (!AIError.isProviderRetryableError(error)) return undefined;

	const message = errorMessage(error);
	const statedResetMs = parseDevinRateLimitResetMs(message);
	if (statedResetMs !== undefined) {
		// One second of slack, because waiting until the exact stated instant races the server's own
		// clock and a retry that lands a moment early just burns an attempt.
		const waitMs = statedResetMs + 1_000;
		return waitMs > DEVIN_RETRY_MAX_DELAY_MS ? undefined : waitMs;
	}
	return Math.min(DEVIN_RETRY_BASE_DELAY_MS * 2 ** state.attempt, DEVIN_RETRY_MAX_DELAY_MS);
}

/** Map trailer error to structured API error instance. */
export function devinTrailerFailure(trailer: DevinTrailerError): Error {
	const status = AIError.connectFailureStatus(trailer);
	if (status === undefined) return new AIError.ValidationError(trailer.text);
	return new AIError.DevinApiError(trailer.text, status);
}
