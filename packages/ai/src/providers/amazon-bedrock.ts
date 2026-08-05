/**
 * Amazon Bedrock Converse Stream provider.
 *
 * Talks directly to `bedrock-runtime.{region}.amazonaws.com` over HTTPS with
 * SigV4 signing and decodes the `application/vnd.amazon.eventstream` response.
 * No `@aws-sdk/*`, no `@smithy/*`, no `proxy-agent`. Proxies are honored via
 * Bun's native `HTTPS_PROXY` support.
 */

import type { Effort } from "@veyyon/catalog/effort";
import { mapEffortToAnthropicAdaptiveEffort, requireSupportedEffort } from "@veyyon/catalog/model-thinking";
import { calculateCost, emptyUsage } from "@veyyon/catalog/models";
import { $env, $flag } from "@veyyon/utils/env";
import { fetchWithRetry } from "@veyyon/utils/fetch-retry";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { AUTHENTICATED_API_KEY_SENTINEL } from "../provider-env-keys";
import { BEDROCK_CLAUDE_THINKING_BUDGETS, resolveThinkingBudget } from "../reasoning-budget";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { normalizeToolCallId, resolveCacheRetention } from "../utils";
import {
	clearStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { toolWireSchema } from "../utils/schema/wire";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { decodeEventStream } from "./aws-eventstream";
import { signRequest } from "./aws-sigv4";
import { supportsBedrockPromptCaching } from "./bedrock-prompt-cache";
import { transformMessages } from "./transform-messages";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	/** Amazon Bedrock API key sent as `Authorization: Bearer`, ahead of SigV4 credential resolution. */
	bearerToken?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: Effort;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude returns thinking content in Bedrock responses.
	 * - `"summarized"`: thinking blocks include human-readable summaries (default here).
	 * - `"omitted"`: thinking content is suppressed; the encrypted signature still
	 *   travels back for multi-turn continuity.
	 *
	 * Starting with Claude Opus 4.7 and Claude Fable/Mythos 5 the Anthropic API
	 * default is `"omitted"`, which leaves callers waiting on a silent stream during
	 * long reasoning runs (issue #1373). We default to `"summarized"` so adaptive-
	 * thinking models that accept the field keep producing visible thinking deltas.
	 * Older adaptive-thinking models (Opus 4.6, Sonnet 4.6+) reject the field, so
	 * we omit it for them.
	 */
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

/**
 * Default AWS region for each Bedrock cross-region inference-profile geo prefix.
 * A geo-prefixed profile (e.g. `eu.anthropic.claude-…`) is only servable from
 * regions in its own geo, so routing one to `us-east-1` yields HTTP 400 "The
 * provided model identifier is invalid." `global.` profiles are anchored in the
 * us regions and intentionally absent here (they resolve fine via `us-east-1`).
 */
const INFERENCE_PROFILE_GEO_DEFAULT_REGION: Record<string, string> = {
	us: "us-east-1",
	"us-gov": "us-gov-west-1",
	eu: "eu-west-1",
	apac: "ap-southeast-1",
	au: "ap-southeast-2",
	jp: "ap-northeast-1",
};

/** Geo prefix of a cross-region inference-profile id, e.g. `eu.anthropic.…` → `eu`. */
function inferenceProfileGeo(modelId: string): string | undefined {
	const dot = modelId.indexOf(".");
	if (dot <= 0) return undefined;
	const prefix = modelId.slice(0, dot);
	return prefix in INFERENCE_PROFILE_GEO_DEFAULT_REGION ? prefix : undefined;
}

/**
 * Whether a concrete AWS region can serve a given inference-profile geo. The
 * `ap-` regions overlap across `apac`/`au`/`jp` profiles, so the Australia and
 * Japan geos pin their specific source regions rather than matching all `ap-*`.
 */
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

/**
 * Resolve the Bedrock runtime region for a request. An explicit per-request
 * region and an ARN-embedded region win outright. Otherwise, for a geo-prefixed
 * cross-region inference profile (`us.`/`eu.`/`apac.`/`au.`/`jp.`/`us-gov.`), an
 * ambient region (`AWS_REGION` / `AWS_DEFAULT_REGION`) is honored only when it
 * can serve the profile's geo; a mismatched or absent ambient region is
 * corrected to the geo default so an `eu.`/`apac.` profile never POSTs to a `us`
 * endpoint (and vice versa). `global.` profiles have no geo entry, so the
 * ambient region (or `us-east-1`) is used unchanged.
 */
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

type Block = (TextContent | ThinkingContent | ToolCall) & {
	[kStreamingBlockIndex]?: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
};

// ---------- Bedrock wire-format types ----------
// Mirrors only what we actually consume from `ConverseStreamRequest` /
// `ConverseStreamOutput`. Keeps us decoupled from `@aws-sdk/client-bedrock-runtime`.

interface CachePoint {
	cachePoint: { type: "default"; ttl?: "5m" | "1h" };
}
interface TextBlockWire {
	text: string;
}
interface ImageBlockWire {
	image: { format: "jpeg" | "png" | "gif" | "webp"; source: { bytes: string } };
}
interface ToolUseBlockWire {
	toolUse: { toolUseId: string; name: string; input: unknown };
}
interface ToolResultBlockWire {
	toolResult: {
		toolUseId: string;
		content: Array<TextBlockWire | ImageBlockWire>;
		status: "success" | "error";
	};
}
interface ReasoningBlockWire {
	reasoningContent: { reasoningText: { text: string; signature?: string } };
}

type UserContent = TextBlockWire | ImageBlockWire | ToolResultBlockWire | CachePoint;
type AssistantContent = TextBlockWire | ToolUseBlockWire | ReasoningBlockWire;
type SystemContent = TextBlockWire | CachePoint;

interface WireMessage {
	role: "user" | "assistant";
	content: Array<UserContent | AssistantContent>;
}

interface WireToolSpec {
	toolSpec: { name: string; description: string; inputSchema: { json: unknown } };
}
interface WireToolChoice {
	auto?: Record<string, never>;
	any?: Record<string, never>;
	tool?: { name: string };
}
interface WireToolConfig {
	tools: WireToolSpec[];
	toolChoice?: WireToolChoice;
}

/**
 * Bedrock validates that requests carrying any `toolUse`/`toolResult` history
 * include a `toolConfig`. For no-tool ephemeral turns (`/btw`, IRC auto-replies)
 * we have nothing real to send, so we inject this placeholder. Its presence is
 * tracked by a per-request flag — never the wire name — so callers who happen
 * to register a real tool literally called `__no_tools__` are not affected.
 */
const NO_TOOLS_SENTINEL_NAME = "__no_tools__";

const NO_TOOLS_SENTINEL: WireToolSpec = {
	toolSpec: {
		name: NO_TOOLS_SENTINEL_NAME,
		description: "Placeholder required by Bedrock validation. Do not call; answer with text.",
		inputSchema: { json: { type: "object", properties: {} } },
	},
};

interface BedrockToolPlan {
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

// Streaming events (snake_case matches the JSON envelope key, but Bedrock uses camelCase).
interface MessageStartEvent {
	role: "user" | "assistant";
}
interface ContentBlockStartEvent {
	contentBlockIndex: number;
	start?: { toolUse?: { toolUseId?: string; name?: string } };
}
interface ContentBlockDeltaEvent {
	contentBlockIndex: number;
	delta?: {
		text?: string;
		toolUse?: { input?: string };
		reasoningContent?: { text?: string; signature?: string };
	};
}
interface ContentBlockStopEvent {
	contentBlockIndex: number;
}
interface MessageStopEvent {
	stopReason?: string;
}
interface MetadataEvent {
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
		const region = resolveBedrockRegion(model.id, options);

		try {
			let sentinelInjected = false;
			let bearerToken: string | undefined;
			const host = `bedrock-runtime.${region}.amazonaws.com`;
			const url = `https://${host}/model/${encodeURIComponent(model.id)}/converse-stream`;
			const urlPath = `/model/${encodeURIComponent(model.id)}/converse-stream`;
			const baseHeaders: Record<string, string> = {
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
			};

			// Bun's native fetch ceiling is disabled below (`timeout: false`) so
			// configurable watchdogs govern slow-prefill streams (issue #2422).
			// Direct callers that bypass `register-builtins` (which installs the
			// iterator-level first-event watchdog) still need a pre-response
			// timer, otherwise a Bedrock/proxy that accepts the POST and never
			// sends headers would hang forever.
			const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs();
			// Clear the pre-response timer the instant headers arrive (below): an
			// absolute `AbortSignal.timeout` would keep aborting the actively
			// streaming body, not just a stalled time-to-first-byte (issue #2422).
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
					// A response hook is part of the request contract, not a transport
					// failure. Return a non-retryable sentinel so fetchWithRetry cannot
					// multiply the callback failure into more physical attempts.
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

				// Bedrock rejects thinking + forced tool_choice ("any" or specific tool).
				// When tool_choice forces tool use, disable thinking to avoid API errors.
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
					body: commandInput,
				};
				const body = new TextEncoder().encode(JSON.stringify(commandInput));

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
				// Preserve the provider's payload-capture contract for an
				// already-aborted call without creating a physical attempt.
				if (watchdog.signal?.aborted) await prepareRequest();
				response = await fetchWithRetry(url, {
					method: "POST",
					signal: watchdog.signal,
					fetch: observedFetch,
					timeout: false,
					prepareInit: prepareRequest,
				});
				if (responseHookFailed) throw responseHookError;
			} finally {
				watchdog.clear();
			}

			if (!response.ok) {
				if (!bearerToken && (response.status === 401 || response.status === 403)) {
					// Stale cached credentials (e.g. rotated session keys in ~/.aws/credentials) —
					// drop the cache entry so the next attempt re-resolves from scratch.
					invalidateAwsCredentialCache({ profile: options.profile, region });
				}
				// The STATUS is the failure; the body is Bedrock's explanation of it. Losing an unreadable body still
				// leaves the status, which is what the error below is built from.
				const errBody = await response.text().catch(() => "");
				throw new AIError.BedrockApiError(
					`Bedrock HTTP ${response.status}: ${errBody.slice(0, 1000)}`,
					response.status,
					{
						headers: response.headers,
					},
				);
			}
			if (!response.body) throw new AIError.BedrockApiError("Bedrock response has no body", response.status);

			// Track first event for the abort/diagnostic path (currently informational).
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
						// no-op: first event marker is implicit by stream entry.
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
						const ev = payload as MessageStopEvent;
						// A sentinel-only request must never surface a tool-use stop:
						// no real tool exists for the agent to dispatch.
						output.stopReason =
							sentinelInjected && ev.stopReason === "tool_use" ? "stop" : mapStopReason(ev.stopReason);
						if (output.stopReason === "error") {
							output.errorMessage = `Generation failed with stop reason: ${ev.stopReason ?? "unknown"}`;
						}
						break;
					}
					case "metadata": {
						handleMetadata(payload as MetadataEvent, model, output);
						break;
					}
					default:
						// Unknown event types (Bedrock may add new ones) — ignore.
						break;
				}
			}

			if (options.signal?.aborted) throw new AIError.RequestAbortError();

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
			// Enrich error with thinking block diagnostics for signature-related failures
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
			const result = await AIError.finalize(error, { api: model.api, signal: options.signal, rawRequestDump });
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

function safeParsePayload(payload: Uint8Array): unknown {
	if (payload.length === 0) return {};
	try {
		return JSON.parse(new TextDecoder().decode(payload));
	} catch {
		// Undefined is DISTINCT from the `{}` an empty payload returns, and the caller relies on that: an
		// unparseable event frame is skipped rather than treated as an empty event, so a malformed frame
		// cannot look like a legitimate no-op in the stream.
		return undefined;
	}
}

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	sentinelInjected: boolean,
): void {
	const index = event.contentBlockIndex;
	const start = event.start;

	// Drop the sentinel call only when we injected it ourselves. A caller that
	// registers a real tool named `__no_tools__` would otherwise lose its
	// legitimate tool-use events on normal turns.
	if (sentinelInjected && start?.toolUse?.name === NO_TOOLS_SENTINEL_NAME) return;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: normalizeToolCallId(start.toolUse.toolUseId || ""),
			name: start.toolUse.name || "",
			arguments: {},
			[kStreamingPartialJson]: "",
			[kStreamingBlockIndex]: index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex;
	const delta = event.delta;
	let index = blocks.findIndex(b => b[kStreamingBlockIndex] === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// If no text block exists yet, create one — `handleContentBlockStart` is not sent for text blocks
		if (!block) {
			const newBlock: Block = { type: "text", text: "", [kStreamingBlockIndex]: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block[kStreamingPartialJson] = (block[kStreamingPartialJson] || "") + (delta.toolUse.input || "");
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = {
				type: "thinking",
				thinking: "",
				thinkingSignature: "",
				[kStreamingBlockIndex]: contentBlockIndex,
			};
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			if (delta.reasoningContent.signature) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
		}
	}
}

function handleMetadata(event: MetadataEvent, model: Model<"bedrock-converse-stream">, output: AssistantMessage): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex(b => b[kStreamingBlockIndex] === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block[kStreamingPartialJson]);
			clearStreamingPartialJson(block);
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (Nova, Titan, Mistral, Llama, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	return id.includes("anthropic.claude") || id.includes("anthropic/claude");
}

/**
 * Serialize the system blocks, anchoring the stable prefix separately from the
 * volatile tail.
 *
 * A single trailing `cachePoint` caches a prefix that ENDS at the last system
 * block, so any edit to a later block invalidates the whole system prompt and
 * the next turn re-reads and re-writes all of it. That is the normal shape
 * here: the first block is the harness shared across parent and subagent
 * prompts, and project context, the assignment and the handle table are
 * appended after it and change constantly. The Anthropic provider anchors its
 * own first block for exactly this reason (`applyPromptCaching`); Bedrock did
 * not, so the two transports disagreed about the same conversation.
 *
 * This is AWS's own guidance, not an invention: the Bedrock prompt-caching
 * page says to use multiple cache checkpoints "if you are caching sections
 * that change at different frequencies", which is exactly a fixed harness
 * followed by a handle table that changes every turn.
 *
 * Budget: Claude allows four cache checkpoints per request. This spends two on
 * system (the anchor plus the trailing block) and `convertMessages` spends one
 * on the last message, so three of four, leaving one unspent. Adding the
 * anchor cannot break a request: per the same page, "if you try to add a cache
 * checkpoint before meeting the minimum number of tokens, your inference will
 * still succeed, but your prefix will not be cached", so a stable prefix under
 * the model's floor (1024 tokens on Sonnet 4.6, 4096 on the 4.5 generation)
 * costs an unused slot and nothing else. Both checkpoints carry the same ttl,
 * which keeps the documented ordering rule (longer TTLs must precede shorter
 * ones) satisfied by construction.
 *
 * There is no Claude Code billing layout on this path: Bedrock authenticates
 * with AWS credentials and this function injects no blocks of its own, so
 * index 0 is always the caller's first prompt, and the anchor index needs none
 * of the offsetting the Anthropic path does.
 */
function buildSystemPrompt(
	systemPrompt: readonly string[] | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContent[] | undefined {
	const prompts = systemPrompt?.map(prompt => prompt.toWellFormed()).filter(prompt => prompt.length > 0) ?? [];
	if (prompts.length === 0) return undefined;
	if (cacheRetention === "none" || !supportsBedrockPromptCaching(model)) {
		return prompts.map(prompt => ({ text: prompt }));
	}

	const cachePoint = (): SystemContent => ({
		cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
	});
	const blocks: SystemContent[] = [];
	for (let index = 0; index < prompts.length; index++) {
		blocks.push({ text: prompts[index] });
		// A single-block system prompt needs no anchor: the trailing checkpoint
		// below already ends at that same block, and a duplicate would spend a
		// slot to cache a prefix that is cached anyway.
		if (index === 0 && prompts.length > 1) blocks.push(cachePoint());
	}
	blocks.push(cachePoint());
	return blocks;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): WireMessage[] {
	const result: WireMessage[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "developer":
			case "user":
				if (typeof m.content === "string") {
					// Skip empty user messages
					if (!m.content || m.content.trim() === "") continue;
					result.push({ role: "user", content: [{ text: m.content.toWellFormed() }] });
				} else {
					const contentBlocks: UserContent[] = [];
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const text = c.text.toWellFormed();
								if (text.trim().length === 0) continue;
								contentBlocks.push({ text });
								break;
							}
							case "image":
								contentBlocks.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								throw new AIError.ValidationError("Unknown user content type");
						}
					}
					// Skip message if all blocks filtered out
					if (contentBlocks.length === 0) continue;
					result.push({ role: "user", content: contentBlocks });
				}
				break;
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) continue;
				const contentBlocks: AssistantContent[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text":
							// Skip empty text blocks
							if (c.text.trim().length === 0) continue;
							contentBlocks.push({ text: c.text.toWellFormed() });
							break;
						case "toolCall":
							contentBlocks.push({
								toolUse: {
									toolUseId: normalizeToolCallId(c.id),
									name: c.name,
									input: c.arguments,
								},
							});
							break;
						case "thinking":
							// Skip empty thinking blocks
							if (c.thinking.trim().length === 0) continue;
							// Thinking blocks require a valid signature when sent as reasoningContent.
							// If the signature is missing (e.g., from an aborted stream), or the model
							// doesn't support signatures, convert to plain text instead.
							if (supportsThinkingSignature(model) && c.thinkingSignature) {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: c.thinking.toWellFormed(), signature: c.thinkingSignature },
									},
								});
							} else if (!supportsThinkingSignature(model)) {
								// Model doesn't support signatures at all — send as unsigned reasoning
								contentBlocks.push({
									reasoningContent: { reasoningText: { text: c.thinking.toWellFormed() } },
								});
							} else {
								// Model requires signature but we don't have one — demote to text
								contentBlocks.push({ text: renderDemotedThinking(model.id, c.thinking) });
							}
							break;
						default:
							throw new AIError.ValidationError("Unknown assistant content type");
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) continue;
				result.push({ role: "assistant", content: contentBlocks });
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message —
				// Bedrock requires all tool results to be in one message.
				const toolResults: ToolResultBlockWire[] = [];
				toolResults.push({
					toolResult: {
						toolUseId: normalizeToolCallId(m.toolCallId),
						content: m.content.map(c =>
							c.type === "image"
								? { image: createImageBlock(c.mimeType, c.data) }
								: { text: c.text.toWellFormed() },
						),
						status: m.isError ? "error" : "success",
					},
				});

				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: normalizeToolCallId(nextMsg.toolCallId),
							content: nextMsg.content.map(c =>
								c.type === "image"
									? { image: createImageBlock(c.mimeType, c.data) }
									: { text: c.text.toWellFormed() },
							),
							status: nextMsg.isError ? "error" : "success",
						},
					});
					j++;
				}
				i = j - 1;

				result.push({ role: "user", content: toolResults });
				break;
			}
			default:
				throw new AIError.ValidationError("Unknown message role");
		}
	}

	// Add cache point to the last user message for supported Claude models
	if (cacheRetention !== "none" && supportsBedrockPromptCaching(model) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === "user" && lastMessage.content) {
			(lastMessage.content as UserContent[]).push({
				cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
			});
		}
	}

	return result;
}

function messagesHaveToolBlocks(messages: WireMessage[]): boolean {
	for (const message of messages) {
		for (const block of message.content) {
			if ("toolUse" in block || "toolResult" in block) return true;
		}
	}
	return false;
}

function convertToolSpec(tool: Tool): WireToolSpec {
	return {
		toolSpec: {
			name: tool.name,
			description: tool.description || "",
			inputSchema: { json: toolWireSchema(tool) },
		},
	};
}

function planToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	messages: WireMessage[],
): BedrockToolPlan {
	const activeTools = tools ?? [];
	const hasTools = activeTools.length > 0;
	const historyHasToolBlocks = messagesHaveToolBlocks(messages);

	if (toolChoice === "none") {
		if (!historyHasToolBlocks) return { toolConfig: undefined, sentinelInjected: false };
		if (!hasTools) {
			return {
				toolConfig: { tools: [NO_TOOLS_SENTINEL], toolChoice: { auto: {} } },
				sentinelInjected: true,
			};
		}
		return { toolConfig: { tools: activeTools.map(convertToolSpec) }, sentinelInjected: false };
	}

	if (!hasTools) return { toolConfig: undefined, sentinelInjected: false };

	const bedrockTools = activeTools.map(convertToolSpec);
	let bedrockToolChoice: WireToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { toolConfig: { tools: bedrockTools, toolChoice: bedrockToolChoice }, sentinelInjected: false };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, unknown> | undefined {
	const reasoning = options.reasoning;
	if (!reasoning || !model.reasoning) return undefined;

	const mode = model.thinking?.mode;
	if (mode === "anthropic-adaptive") {
		const effort = mapEffortToAnthropicAdaptiveEffort(model, reasoning);
		// Starting with Claude Opus 4.7 and Claude Fable/Mythos 5, Anthropic switched
		// the adaptive-thinking default to "omitted", which silently suppresses
		// streamed reasoning and can read as a stalled stream during long reasoning
		// runs (issue #1373). Opt back into "summarized" by default on models that
		// accept the field.
		const adaptive: { type: "adaptive"; display?: BedrockThinkingDisplay } = { type: "adaptive" };
		if (model.thinking?.supportsDisplay) {
			adaptive.display = options.thinkingDisplay ?? "summarized";
		}
		return {
			thinking: adaptive,
			output_config: { effort },
		};
	}

	const level = requireSupportedEffort(model, reasoning);
	const budget = resolveThinkingBudget(level, BEDROCK_CLAUDE_THINKING_BUDGETS, options.thinkingBudgets);

	const result: Record<string, unknown> = {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
			display: options.thinkingDisplay ?? "summarized",
		},
	};

	if (options.interleavedThinking) {
		result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	}

	return result;
}

/**
 * Bedrock's wire format expects the image as `{ source: { bytes: <base64-string> }, format }`.
 * The caller already passes base64-encoded data, so no decode/re-encode round-trip is needed.
 */
function createImageBlock(mimeType: string, data: string): ImageBlockWire["image"] {
	let format: "jpeg" | "png" | "gif" | "webp";
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = "jpeg";
			break;
		case "image/png":
			format = "png";
			break;
		case "image/gif":
			format = "gif";
			break;
		case "image/webp":
			format = "webp";
			break;
		default:
			throw new AIError.ValidationError(`Unknown image type: ${mimeType}`);
	}
	return { source: { bytes: data }, format };
}
