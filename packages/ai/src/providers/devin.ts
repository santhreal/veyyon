import { scheduler } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { normalizeDevinSessionToken } from "@veyyon/catalog/discovery/devin";
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	MetadataSchema,
	StopReason,
} from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { calculateCost, discardAttemptUsage, emptyUsage } from "@veyyon/catalog/models";
import { DEVIN_CASCADE_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { clearStreamingPartialJson, setStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";

export { DEVIN_CASCADE_ENDPOINT } from "@veyyon/catalog/provider-endpoints";

import {
	buildDevinChatRequest,
	devinRetryDelayMs,
	devinTrailerFailure,
	fetchDevinAuthMetadata,
	readConnectTrailerError,
} from "./devin-helpers";

export {
	DEVIN_EXTENSION_NAME,
	DEVIN_EXTENSION_VERSION,
	DEVIN_IDE_NAME,
	DEVIN_IDE_VERSION,
} from "@veyyon/catalog/discovery/devin";

export {
	devinTrailerFailure,
	parseDevinRateLimitResetMs,
} from "./devin-helpers";

export interface DevinOptions extends StreamOptions {
	chatModelUid?: string;
	devinRetryAttempt?: number;
}

export const DEVIN_MAX_PROVIDER_RETRIES = 3;
export const DEVIN_RETRY_BASE_DELAY_MS = 1_000;
export const DEVIN_RETRY_MAX_DELAY_MS = 90_000;

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
export const DEVIN_DEFAULT_STOP_PATTERNS = [
	"<|user|>",
	"<|bot|>",
	"<|context_request|>",
	"<|endoftext|>",
	"<|end_of_turn|>",
];

const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
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
