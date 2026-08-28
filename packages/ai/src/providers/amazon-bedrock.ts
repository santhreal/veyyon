import type { Effort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import { $env, $flag } from "@veyyon/utils/env";
import * as AIError from "../error";
import { AUTHENTICATED_API_KEY_SENTINEL } from "../provider-env-keys";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
} from "../types";
import { resolveCacheRetention } from "../utils";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { fetchProviderWithRetry } from "../utils/provider-fetch";
import { notifyProviderResponse } from "../utils/provider-response";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import {
	buildAdditionalModelRequestFields,
	buildSystemPrompt,
	convertMessages,
	handleContentBlockDelta,
	handleContentBlockStart,
	handleContentBlockStop,
	handleMetadata,
	mapStopReason,
	planToolConfig,
	safeParsePayload,
} from "./amazon-bedrock-helpers";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { decodeEventStream } from "./aws-eventstream";
import { signRequest } from "./aws-sigv4";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	bearerToken?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	reasoning?: Effort;
	thinkingBudgets?: ThinkingBudgets;
	interleavedThinking?: boolean;
	thinkingDisplay?: BedrockThinkingDisplay;
}

function resolveBearerToken(options: BedrockOptions): string | undefined {
	const apiKey = options.apiKey === AUTHENTICATED_API_KEY_SENTINEL ? undefined : options.apiKey;
	return options.bearerToken || apiKey || $env.AWS_BEARER_TOKEN_BEDROCK;
}

function inferRegionFromBedrockArn(modelId: string): string | undefined {
	const parts = modelId.split(":", 6);
	if (parts[0] !== "arn" || parts[2] !== "bedrock") return undefined;
	const region = parts[3];
	return region || undefined;
}

const INFERENCE_PROFILE_GEO_DEFAULT_REGION: Record<string, string> = {
	us: "us-east-1",
	"us-gov": "us-gov-west-1",
	eu: "eu-west-1",
	apac: "ap-southeast-1",
	au: "ap-southeast-2",
	jp: "ap-northeast-1",
};

function inferenceProfileGeo(modelId: string): string | undefined {
	const dot = modelId.indexOf(".");
	if (dot <= 0) return undefined;
	const prefix = modelId.slice(0, dot);
	return prefix in INFERENCE_PROFILE_GEO_DEFAULT_REGION ? prefix : undefined;
}

function regionServesGeo(region: string, geo: string): boolean {
	switch (geo) {
		case "us-gov":
			return region.startsWith("us-gov-");
		case "us":
			return region.startsWith("us-") && !region.startsWith("us-gov-");
		case "eu":
			return region.startsWith("eu-");
		case "apac":
			return region.startsWith("ap-");
		case "au":
			return region === "ap-southeast-2" || region === "ap-southeast-4";
		case "jp":
			return region === "ap-northeast-1" || region === "ap-northeast-3";
		default:
			return false;
	}
}

function resolveBedrockRegion(modelId: string, options: BedrockOptions): string {
	const explicit = options.region || inferRegionFromBedrockArn(modelId);
	if (explicit) return explicit;
	const ambient = $env.AWS_REGION || $env.AWS_DEFAULT_REGION;
	const geo = inferenceProfileGeo(modelId);
	if (geo) {
		if (ambient && regionServesGeo(ambient, geo)) return ambient;
		return INFERENCE_PROFILE_GEO_DEFAULT_REGION[geo];
	}
	return ambient || "us-east-1";
}

export type Block = (TextContent | ThinkingContent | ToolCall) & {
	[kStreamingBlockIndex]?: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
};

interface CachePoint {
	cachePoint: { type: "default"; ttl?: "5m" | "1h" };
}
interface TextBlockWire {
	text: string;
}
export interface ImageBlockWire {
	image: { format: "jpeg" | "png" | "gif" | "webp"; source: { bytes: string } };
}
interface ToolUseBlockWire {
	toolUse: { toolUseId: string; name: string; input: unknown };
}
export interface ToolResultBlockWire {
	toolResult: {
		toolUseId: string;
		content: Array<TextBlockWire | ImageBlockWire>;
		status: "success" | "error";
	};
}
interface ReasoningBlockWire {
	reasoningContent: { reasoningText: { text: string; signature?: string } };
}

export type UserContent = TextBlockWire | ImageBlockWire | ToolResultBlockWire | CachePoint;
export type AssistantContent = TextBlockWire | ToolUseBlockWire | ReasoningBlockWire;
export type SystemContent = TextBlockWire | CachePoint;

export interface WireMessage {
	role: "user" | "assistant";
	content: Array<UserContent | AssistantContent>;
}

export interface WireToolSpec {
	toolSpec: { name: string; description: string; inputSchema: { json: unknown } };
}
export interface WireToolChoice {
	auto?: Record<string, never>;
	any?: Record<string, never>;
	tool?: { name: string };
}
interface WireToolConfig {
	tools: WireToolSpec[];
	toolChoice?: WireToolChoice;
}

export const NO_TOOLS_SENTINEL_NAME = "__no_tools__";

export const NO_TOOLS_SENTINEL: WireToolSpec = {
	toolSpec: {
		name: NO_TOOLS_SENTINEL_NAME,
		description: "Placeholder required by Bedrock validation. Do not call; answer with text.",
		inputSchema: { json: { type: "object", properties: {} } },
	},
};

export interface BedrockToolPlan {
	toolConfig: WireToolConfig | undefined;
	sentinelInjected: boolean;
}

interface ConverseStreamRequest {
	messages: WireMessage[];
	system?: SystemContent[];
	inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
	toolConfig?: WireToolConfig;
	additionalModelRequestFields?: Record<string, unknown>;
}

interface MessageStartEvent {
	role: "user" | "assistant";
}
export interface ContentBlockStartEvent {
	contentBlockIndex: number;
	start?: { toolUse?: { toolUseId?: string; name?: string } };
}
export interface ContentBlockDeltaEvent {
	contentBlockIndex: number;
	delta?: {
		text?: string;
		toolUse?: { input?: string };
		reasoningContent?: { text?: string; signature?: string };
	};
}
export interface ContentBlockStopEvent {
	contentBlockIndex: number;
}
interface MessageStopEvent {
	stopReason?: string;
}
export interface MetadataEvent {
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheWriteInputTokens?: number;
		totalTokens?: number;
	};
}

export const streamBedrock: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const blocks = output.content as Block[];
		let rawRequestDump: RawHttpRequestDump | undefined;
		let wireBodyJson: string | undefined;
		const region = resolveBedrockRegion(model.id, options);

		try {
			let sentinelInjected = false;
			let sawMessageStop = false;
			let bearerToken: string | undefined;
			const host = `bedrock-runtime.${region}.amazonaws.com`;
			const url = `https://${host}/model/${encodeURIComponent(model.id)}/converse-stream`;
			const urlPath = `/model/${encodeURIComponent(model.id)}/converse-stream`;
			const baseHeaders: Record<string, string> = {
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
			};

			const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs();
			const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
			const transportFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
			let responseHookFailed = false;
			let responseHookError: unknown;
			const observedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const attemptResponse = await transportFetch(input, init);
				try {
					await notifyProviderResponse(
						options,
						attemptResponse,
						model,
						attemptResponse.headers.get("x-amzn-requestid") ?? attemptResponse.headers.get("x-request-id"),
					);
				} catch (error) {
					responseHookFailed = true;
					responseHookError = error;
					return new Response(null, { status: 400 });
				}
				return attemptResponse;
			};
			const prepareRequest = async (): Promise<RequestInit> => {
				bearerToken = resolveBearerToken(options);
				let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined;
				if (!bearerToken) {
					credentials = $flag("AWS_BEDROCK_SKIP_AUTH")
						? { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" }
						: await resolveAwsCredentials({
								profile: options.profile,
								region,
								signal: options.signal,
								fetch: options.fetch,
							});
				}

				const cacheRetention = resolveCacheRetention(options.cacheRetention);
				const convertedMessages = convertMessages(context, model, cacheRetention);
				const toolPlan = planToolConfig(context.tools, options.toolChoice, convertedMessages);
				const toolConfig = toolPlan.toolConfig;
				sentinelInjected = toolPlan.sentinelInjected;
				let additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);

				if (toolConfig?.toolChoice && additionalModelRequestFields) {
					const tc = toolConfig.toolChoice;
					if (tc.any || tc.tool) additionalModelRequestFields = undefined;
				}

				let commandInput: ConverseStreamRequest = {
					messages: convertedMessages,
					system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
					inferenceConfig: {
						maxTokens: options.maxTokens,
						temperature: options.temperature,
						topP: options.topP,
					},
					toolConfig,
					additionalModelRequestFields,
				};
				const replacementPayload = await options.onPayload?.(commandInput, model);
				if (replacementPayload !== undefined) {
					commandInput = replacementPayload as ConverseStreamRequest;
				}

				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url,
				};
				wireBodyJson = JSON.stringify(commandInput);
				const body = new TextEncoder().encode(wireBodyJson);

				if (bearerToken) {
					return {
						headers: { ...baseHeaders, Authorization: `Bearer ${bearerToken}` },
						body,
					};
				}
				const signed = await signRequest({
					method: "POST",
					host,
					path: urlPath,
					body,
					region,
					service: "bedrock",
					credentials: credentials!,
					headers: baseHeaders,
				});
				return {
					headers: { ...baseHeaders, ...signed },
					body,
				};
			};
			let response: Response;
			try {
				if (watchdog.signal?.aborted) await prepareRequest();
				response = await fetchProviderWithRetry(url, {
					method: "POST",
					signal: watchdog.signal,
					fetch: observedFetch,
					timeout: false,
					prepareInit: prepareRequest,
					maxDelayMs: options?.maxRetryDelayMs,
				});
				if (responseHookFailed) throw responseHookError;
			} finally {
				watchdog.clear();
			}

			if (!response.ok) {
				if (!bearerToken && (response.status === 401 || response.status === 403)) {
					invalidateAwsCredentialCache({ profile: options.profile, region });
				}
				const detail = await AIError.readProviderErrorDetail(response);
				throw new AIError.BedrockApiError(`Bedrock HTTP ${response.status}: ${detail}`, response.status, {
					headers: response.headers,
				});
			}
			if (!response.body) throw new AIError.BedrockApiError("Bedrock response has no body", response.status);

			for await (const message of decodeEventStream(response.body)) {
				const messageType = message.headers[":message-type"];
				const eventType = message.headers[":event-type"];

				if (messageType === "exception") {
					const exceptionType = message.headers[":exception-type"] || "Exception";
					const payload = safeParsePayload(message.payload) as { message?: string } | undefined;
					const errorMessage = payload?.message || new TextDecoder().decode(message.payload);
					const text = `${exceptionType}: ${errorMessage}`;
					throw new AIError.BedrockApiError(text, 400, { code: exceptionType });
				}
				if (messageType === "error") {
					const code = message.headers[":error-code"] || "UnknownError";
					const errorMessage = message.headers[":error-message"] || new TextDecoder().decode(message.payload);
					throw new AIError.BedrockApiError(`${code}: ${errorMessage}`, 400, { code });
				}
				if (messageType !== "event") continue;

				const payload = safeParsePayload(message.payload);
				if (!payload) continue;

				switch (eventType) {
					case "messageStart": {
						const ev = payload as MessageStartEvent;
						if (ev.role !== "assistant") {
							throw new AIError.BedrockApiError(
								"Unexpected assistant message start but got user message start instead",
								0,
							);
						}
						stream.push({ type: "start", partial: output });
						break;
					}
					case "contentBlockStart": {
						if (!firstTokenTime) firstTokenTime = performance.now();
						handleContentBlockStart(payload as ContentBlockStartEvent, blocks, output, stream, sentinelInjected);
						break;
					}
					case "contentBlockDelta": {
						if (!firstTokenTime) firstTokenTime = performance.now();
						handleContentBlockDelta(payload as ContentBlockDeltaEvent, blocks, output, stream);
						break;
					}
					case "contentBlockStop": {
						handleContentBlockStop(payload as ContentBlockStopEvent, blocks, output, stream);
						break;
					}
					case "messageStop": {
						sawMessageStop = true;
						const ev = payload as MessageStopEvent;
						output.stopReason =
							sentinelInjected && ev.stopReason === "tool_use" ? "stop" : mapStopReason(ev.stopReason);
						if (output.stopReason === "error") {
							output.errorMessage = AIError.providerFinishErrorMessage(ev.stopReason);
						}
						break;
					}
					case "metadata": {
						handleMetadata(payload as MetadataEvent, model, output);
						break;
					}
					default:
						break;
				}
			}

			if (options.signal?.aborted) throw new AIError.RequestAbortError();

			if (!sawMessageStop) {
				const toolBatchIsComplete = blocks.every(
					block => block.type !== "toolCall" || getStreamingPartialJson(block) === undefined,
				);
				const stopReason = stopReasonForTerminallessEof(output.content, toolBatchIsComplete);
				if (stopReason === undefined) {
					throw new AIError.ProviderResponseError(
						"Bedrock event stream ended without a messageStop (connection dropped or response truncated)",
						{ provider: model.provider, kind: "incomplete-stream" },
					);
				}
				output.stopReason = stopReason;
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new AIError.BedrockApiError(output.errorMessage ?? "An unknown error occurred", 0);
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
			let diagnostics = "";
			if (baseMessage.includes("signature") || baseMessage.includes("thinking")) {
				const thinkingBlocks = context.messages
					.filter((m): m is AssistantMessage => m.role === "assistant")
					.flatMap((m, mi) =>
						m.content
							.filter(b => b.type === "thinking")
							.map((b, bi) => ({
								msg: mi,
								block: bi,
								stop: m.stopReason,
								sigLen: b.thinkingSignature?.length ?? -1,
								thinkLen: b.thinking.length,
							})),
					);
				if (thinkingBlocks.length > 0) {
					diagnostics = `\n[thinking-diag] ${JSON.stringify(thinkingBlocks)}`;
				}
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				signal: options.signal,
				rawRequestDump: materializeDumpBody(rawRequestDump, wireBodyJson),
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message + diagnostics;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};
