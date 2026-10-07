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
import { calculateCost } from "@veyyon/catalog/models";
import { $env, $flag } from "@veyyon/utils/env";
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
	ImageContent,
	Message,
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
	UserMessage,
} from "../types";
import { normalizeToolCallId, resolveCacheRetention } from "../utils";
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
import { toolWireSchema } from "../utils/schema/wire";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { decodeEventStream, type EventStreamMessage } from "./aws-eventstream";
import { type AwsCredentials, signRequest } from "./aws-sigv4";
import { supportsBedrockPromptCaching } from "./bedrock-prompt-cache";
import { createInitialResponsesAssistantMessage } from "./initial-message";
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

const BEDROCK_REQUEST_HEADERS: Readonly<Record<string, string>> = {
	"content-type": "application/json",
	accept: "application/vnd.amazon.eventstream",
};

/** One Converse Stream turn: its signed request, its event stream and the assistant message they build. */
class BedrockTurn {
	readonly stream = new AssistantMessageEventStream();
	readonly #model: Model<"bedrock-converse-stream">;
	readonly #context: Context;
	readonly #options: BedrockOptions;
	readonly #startTime = performance.now();
	readonly #output: AssistantMessage;
	readonly #blocks: Block[];
	readonly #region: string;
	#firstTokenTime: number | undefined;
	#rawRequestDump: RawHttpRequestDump | undefined;
	/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
	#wireBodyJson: string | undefined;
	#bearerToken: string | undefined;
	#sentinelInjected = false;
	#sawMessageStop = false;
	#responseHookFailed = false;
	#responseHookError: unknown;

	constructor(model: Model<"bedrock-converse-stream">, context: Context, options: BedrockOptions) {
		this.#model = model;
		this.#context = context;
		this.#options = options;
		this.#output = createInitialResponsesAssistantMessage("bedrock-converse-stream" as Api, model.provider, model.id);
		this.#blocks = this.#output.content as Block[];
		this.#region = resolveBedrockRegion(model.id, options);
	}

	async run(): Promise<void> {
		try {
			const body = await this.#open();
			for await (const frame of decodeEventStream(body)) this.#onFrame(frame);
			this.#finish();
		} catch (error) {
			await this.#fail(error);
		}
	}

	async #open(): Promise<ReadableStream<Uint8Array>> {
		const response = await this.#send();
		if (!response.ok) throw await this.#refusal(response);
		if (!response.body) throw new AIError.BedrockApiError("Bedrock response has no body", response.status);
		return response.body;
	}

	async #send(): Promise<Response> {
		const options = this.#options;
		const host = `bedrock-runtime.${this.#region}.amazonaws.com`;
		const path = `/model/${encodeURIComponent(this.#model.id)}/converse-stream`;
		const url = `https://${host}${path}`;
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
		const prepareInit = () => this.#prepareRequest(url, host, path);
		try {
			// Preserve the provider's payload-capture contract for an
			// already-aborted call without creating a physical attempt.
			if (watchdog.signal?.aborted) await prepareInit();
			const response = await fetchProviderWithRetry(url, {
				method: "POST",
				signal: watchdog.signal,
				fetch: this.#observedFetch(),
				timeout: false,
				prepareInit,
				maxDelayMs: options?.maxRetryDelayMs,
			});
			if (this.#responseHookFailed) throw this.#responseHookError;
			return response;
		} finally {
			watchdog.clear();
		}
	}

	/** The transport fetch, reporting each attempt's response to the caller's response hook. */
	#observedFetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
		const transportFetch = this.#options.fetch ?? globalThis.fetch.bind(globalThis);
		return async (input, init) => {
			const attemptResponse = await transportFetch(input, init);
			try {
				await notifyProviderResponse(
					this.#options,
					attemptResponse,
					this.#model,
					attemptResponse.headers.get("x-amzn-requestid") ?? attemptResponse.headers.get("x-request-id"),
				);
			} catch (error) {
				// A response hook is part of the request contract, not a transport
				// failure. Return a non-retryable sentinel so fetchWithRetry cannot
				// multiply the callback failure into more physical attempts.
				this.#responseHookFailed = true;
				this.#responseHookError = error;
				return new Response(null, { status: 400 });
			}
			return attemptResponse;
		};
	}

	async #prepareRequest(url: string, host: string, path: string): Promise<RequestInit> {
		const credentials = await this.#resolveCredentials();
		const request = await this.#buildRequest();
		this.#rawRequestDump = {
			provider: this.#model.provider,
			api: this.#output.api,
			model: this.#model.id,
			method: "POST",
			url,
		};
		// Retain the exact sent BYTES, not the parsed object: a dump body is
		// read only on the 400/413 path.
		this.#wireBodyJson = JSON.stringify(request);
		const body = new TextEncoder().encode(this.#wireBodyJson);
		if (!credentials) {
			return { headers: { ...BEDROCK_REQUEST_HEADERS, Authorization: `Bearer ${this.#bearerToken}` }, body };
		}
		const signed = await signRequest({
			method: "POST",
			host,
			path,
			body,
			region: this.#region,
			service: "bedrock",
			credentials,
			headers: BEDROCK_REQUEST_HEADERS,
		});
		return { headers: { ...BEDROCK_REQUEST_HEADERS, ...signed }, body };
	}

	/** SigV4 credentials, or undefined when a bearer token authenticates the request instead. */
	async #resolveCredentials(): Promise<AwsCredentials | undefined> {
		this.#bearerToken = resolveBearerToken(this.#options);
		if (this.#bearerToken) return undefined;
		if ($flag("AWS_BEDROCK_SKIP_AUTH")) {
			return { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" };
		}
		return resolveAwsCredentials({
			profile: this.#options.profile,
			region: this.#region,
			signal: this.#options.signal,
			fetch: this.#options.fetch,
		});
	}

	async #buildRequest(): Promise<ConverseStreamRequest> {
		const model = this.#model;
		const context = this.#context;
		const options = this.#options;
		const cacheRetention = resolveCacheRetention(options.cacheRetention);
		const messages = convertMessages(context, model, cacheRetention);
		const { toolConfig, sentinelInjected } = planToolConfig(context.tools, options.toolChoice, messages);
		this.#sentinelInjected = sentinelInjected;
		const additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);
		// Bedrock rejects thinking + forced tool_choice ("any" or specific tool),
		// so a request that forces tool use drops the thinking fields.
		const forcesToolUse = toolConfig?.toolChoice?.any || toolConfig?.toolChoice?.tool;
		const request: ConverseStreamRequest = {
			messages,
			system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
			inferenceConfig: {
				maxTokens: options.maxTokens,
				temperature: options.temperature,
				topP: options.topP,
			},
			toolConfig,
			additionalModelRequestFields: forcesToolUse ? undefined : additionalModelRequestFields,
		};
		const replacement = await options.onPayload?.(request, model);
		return replacement === undefined ? request : (replacement as ConverseStreamRequest);
	}

	/** The error a non-2xx response stands for. A 401 or 403 also drops cached SigV4 credentials. */
	async #refusal(response: Response): Promise<AIError.BedrockApiError> {
		if (!this.#bearerToken && (response.status === 401 || response.status === 403)) {
			// Stale cached credentials (e.g. rotated session keys in ~/.aws/credentials) —
			// drop the cache entry so the next attempt re-resolves from scratch.
			invalidateAwsCredentialCache({ profile: this.#options.profile, region: this.#region });
		}
		// The STATUS is the failure; the body is Bedrock's explanation of it. Losing an unreadable body still
		// leaves the status, which is what the error below is built from. The shared reader replaces a local
		// 1000-character slice, so the read is bounded too and truncation says so.
		const detail = await AIError.readProviderErrorDetail(response);
		return new AIError.BedrockApiError(`Bedrock HTTP ${response.status}: ${detail}`, response.status, {
			headers: response.headers,
		});
	}

	#onFrame(frame: EventStreamMessage): void {
		const error = frameError(frame);
		if (error) throw error;
		if (frame.headers[":message-type"] !== "event") return;
		const payload = safeParsePayload(frame.payload);
		if (payload) this.#onEvent(frame.headers[":event-type"], payload);
	}

	#onEvent(eventType: string | undefined, payload: unknown): void {
		switch (eventType) {
			case "messageStart":
				if ((payload as MessageStartEvent).role !== "assistant") {
					throw new AIError.BedrockApiError(
						"Unexpected assistant message start but got user message start instead",
						0,
					);
				}
				this.stream.push({ type: "start", partial: this.#output });
				break;
			case "contentBlockStart":
				this.#firstTokenTime ??= performance.now();
				this.#onContentBlockStart(payload as ContentBlockStartEvent);
				break;
			case "contentBlockDelta":
				this.#firstTokenTime ??= performance.now();
				this.#onContentBlockDelta(payload as ContentBlockDeltaEvent);
				break;
			case "contentBlockStop":
				this.#onContentBlockStop(payload as ContentBlockStopEvent);
				break;
			case "messageStop":
				this.#onMessageStop(payload as MessageStopEvent);
				break;
			case "metadata":
				this.#onMetadata(payload as MetadataEvent);
				break;
			// Unknown event types (Bedrock may add new ones) are ignored.
		}
	}

	/** Appends a block to the message and announces it; returns its position. */
	#openBlock(block: Block, type: "text_start" | "thinking_start" | "toolcall_start"): number {
		this.#output.content.push(block);
		const position = this.#blocks.length - 1;
		this.stream.push({ type, contentIndex: position, partial: this.#output });
		return position;
	}

	#onContentBlockStart(event: ContentBlockStartEvent): void {
		const toolUse = event.start?.toolUse;
		// Drop the sentinel call only when we injected it ourselves. A caller that
		// registers a real tool named `__no_tools__` would otherwise lose its
		// legitimate tool-use events on normal turns.
		if (!toolUse || (this.#sentinelInjected && toolUse.name === NO_TOOLS_SENTINEL_NAME)) return;
		this.#openBlock(
			{
				type: "toolCall",
				id: normalizeToolCallId(toolUse.toolUseId || ""),
				name: toolUse.name || "",
				arguments: {},
				[kStreamingPartialJson]: "",
				[kStreamingBlockIndex]: event.contentBlockIndex,
			},
			"toolcall_start",
		);
	}

	#onContentBlockDelta(event: ContentBlockDeltaEvent): void {
		const { contentBlockIndex, delta } = event;
		const position = this.#blocks.findIndex(b => b[kStreamingBlockIndex] === contentBlockIndex);
		const block = this.#blocks[position];
		if (delta?.text !== undefined) {
			// `contentBlockStart` is not sent for text blocks, so the first delta opens one.
			const textPosition = block
				? position
				: this.#openBlock({ type: "text", text: "", [kStreamingBlockIndex]: contentBlockIndex }, "text_start");
			this.#appendText(textPosition, delta.text);
		} else if (delta?.toolUse && block?.type === "toolCall") {
			this.#appendToolInput(block, position, delta.toolUse.input || "");
		} else if (delta?.reasoningContent) {
			const thinkingPosition = block
				? position
				: this.#openBlock(
						{ type: "thinking", thinking: "", thinkingSignature: "", [kStreamingBlockIndex]: contentBlockIndex },
						"thinking_start",
					);
			this.#appendReasoning(thinkingPosition, delta.reasoningContent);
		}
	}

	#appendText(position: number, text: string): void {
		const block = this.#blocks[position];
		if (block.type !== "text") return;
		block.text += text;
		this.stream.push({ type: "text_delta", contentIndex: position, delta: text, partial: this.#output });
	}

	#appendToolInput(block: Extract<Block, { type: "toolCall" }>, position: number, input: string): void {
		block[kStreamingPartialJson] = (block[kStreamingPartialJson] || "") + input;
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		this.stream.push({ type: "toolcall_delta", contentIndex: position, delta: input, partial: this.#output });
	}

	#appendReasoning(position: number, reasoning: { text?: string; signature?: string }): void {
		const block = this.#blocks[position];
		if (block.type !== "thinking") return;
		if (reasoning.text) {
			block.thinking += reasoning.text;
			this.stream.push({
				type: "thinking_delta",
				contentIndex: position,
				delta: reasoning.text,
				partial: this.#output,
			});
		}
		if (reasoning.signature) block.thinkingSignature = (block.thinkingSignature || "") + reasoning.signature;
	}

	#onContentBlockStop(event: ContentBlockStopEvent): void {
		const position = this.#blocks.findIndex(b => b[kStreamingBlockIndex] === event.contentBlockIndex);
		const block = this.#blocks[position];
		const { stream } = this;
		const output = this.#output;
		switch (block?.type) {
			case "text":
				stream.push({ type: "text_end", contentIndex: position, content: block.text, partial: output });
				break;
			case "thinking":
				stream.push({ type: "thinking_end", contentIndex: position, content: block.thinking, partial: output });
				break;
			case "toolCall":
				block.arguments = parseStreamingJson(block[kStreamingPartialJson]);
				clearStreamingPartialJson(block);
				stream.push({ type: "toolcall_end", contentIndex: position, toolCall: block, partial: output });
				break;
		}
	}

	#onMetadata(event: MetadataEvent): void {
		const usage = event.usage;
		if (!usage) return;
		const total = this.#output.usage;
		total.input = usage.inputTokens || 0;
		total.output = usage.outputTokens || 0;
		total.cacheRead = usage.cacheReadInputTokens || 0;
		total.cacheWrite = usage.cacheWriteInputTokens || 0;
		total.totalTokens = usage.totalTokens || total.input + total.output;
		calculateCost(this.#model, total);
	}

	#onMessageStop(event: MessageStopEvent): void {
		this.#sawMessageStop = true;
		const output = this.#output;
		// A sentinel-only request must never surface a tool-use stop:
		// no real tool exists for the agent to dispatch.
		output.stopReason =
			this.#sentinelInjected && event.stopReason === "tool_use" ? "stop" : mapStopReason(event.stopReason);
		if (output.stopReason === "error") {
			output.errorMessage = AIError.providerFinishErrorMessage(event.stopReason);
		}
	}

	#finish(): void {
		if (this.#options.signal?.aborted) throw new AIError.RequestAbortError();
		const output = this.#output;
		if (!this.#sawMessageStop) output.stopReason = this.#terminallessStopReason();
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			throw new AIError.BedrockApiError(output.errorMessage ?? "An unknown error occurred", 0);
		}
		this.#stampTiming();
		this.stream.push({ type: "done", reason: output.stopReason, message: output });
		this.stream.end();
	}

	/**
	 * The stop reason of an event stream that ended without a `messageStop`.
	 *
	 * Nothing in the response said the turn was over, so `output.stopReason` is
	 * still the optimistic seed it was given before the first byte arrived, and
	 * pushing `done` with it reported an empty body as a finished answer. The
	 * shared rule decides what the accumulated content can stand as; a tool batch
	 * counts only when every call parsed, which on this dialect means every one of
	 * them reached `contentBlockStop`.
	 */
	#terminallessStopReason(): StopReason {
		const toolBatchIsComplete = this.#blocks.every(
			block => block.type !== "toolCall" || getStreamingPartialJson(block) === undefined,
		);
		const stopReason = stopReasonForTerminallessEof(this.#output.content, toolBatchIsComplete);
		if (stopReason === undefined) {
			throw new AIError.ProviderResponseError(
				"Bedrock event stream ended without a messageStop (connection dropped or response truncated)",
				{ provider: this.#model.provider, kind: "incomplete-stream" },
			);
		}
		return stopReason;
	}

	#stampTiming(): void {
		this.#output.duration = performance.now() - this.#startTime;
		if (this.#firstTokenTime) this.#output.ttft = this.#firstTokenTime - this.#startTime;
	}

	async #fail(error: unknown): Promise<void> {
		const output = this.#output;
		for (const block of output.content) {
			if (block.type === "toolCall") clearStreamingPartialJson(block);
		}
		const diagnostics = thinkingDiagnostics(error, this.#context.messages);
		const result = await AIError.finalize(error, {
			api: this.#model.api,
			signal: this.#options.signal,
			rawRequestDump: materializeDumpBody(this.#rawRequestDump, this.#wireBodyJson),
		});
		AIError.applyFinalizeResult(output, result, result.message + diagnostics);
		this.#stampTiming();
		this.stream.push({ type: "error", reason: output.stopReason, error: output });
		this.stream.end();
	}
}

export const streamBedrock: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	const turn = new BedrockTurn(model, context, options);
	void turn.run();
	return turn.stream;
};

/** The error an `exception` or `error` frame reports, or undefined for any other frame. */
function frameError(frame: EventStreamMessage): AIError.BedrockApiError | undefined {
	switch (frame.headers[":message-type"]) {
		case "exception": {
			const exceptionType = frame.headers[":exception-type"] || "Exception";
			const payload = safeParsePayload(frame.payload) as { message?: string } | undefined;
			const message = payload?.message || new TextDecoder().decode(frame.payload);
			return new AIError.BedrockApiError(`${exceptionType}: ${message}`, 400, { code: exceptionType });
		}
		case "error": {
			const code = frame.headers[":error-code"] || "UnknownError";
			const message = frame.headers[":error-message"] || new TextDecoder().decode(frame.payload);
			return new AIError.BedrockApiError(`${code}: ${message}`, 400, { code });
		}
		default:
			return undefined;
	}
}

/** Each replayed thinking block's signature and text length, appended to a signature or thinking refusal. */
function thinkingDiagnostics(error: unknown, messages: readonly Message[]): string {
	const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
	if (!baseMessage.includes("signature") && !baseMessage.includes("thinking")) return "";
	const thinkingBlocks = messages
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
	return thinkingBlocks.length > 0 ? `\n[thinking-diag] ${JSON.stringify(thinkingBlocks)}` : "";
}

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
 * here: the first block is the harness shared across parent and agent
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
	const messages = transformMessages(context.messages, model, normalizeToolCallId);
	const signsThinking = supportsThinkingSignature(model);

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult") {
			const converted = convertMessage(message, model.id, signsThinking);
			if (converted) result.push(converted);
			continue;
		}
		// Collect all consecutive toolResult messages into a single user message —
		// Bedrock requires all tool results to be in one message.
		const toolResults = [convertToolResult(message)];
		let next = messages[i + 1];
		while (next?.role === "toolResult") {
			toolResults.push(convertToolResult(next));
			i++;
			next = messages[i + 1];
		}
		result.push({ role: "user", content: toolResults });
	}

	// Add cache point to the last user message for supported Claude models
	const lastMessage = result.at(-1);
	if (cacheRetention !== "none" && supportsBedrockPromptCaching(model) && lastMessage?.role === "user") {
		(lastMessage.content as UserContent[]).push({
			cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
		});
	}

	return result;
}

/**
 * A user, developer or assistant message on the wire, or undefined when nothing
 * in it survives: Bedrock rejects a message with an empty content array, which
 * is what an aborted request or a whitespace-only prompt leaves behind.
 */
function convertMessage(
	message: Exclude<Message, ToolResultMessage>,
	modelId: string,
	signsThinking: boolean,
): WireMessage | undefined {
	switch (message.role) {
		case "developer":
		case "user":
			return convertUserMessage(message.content);
		case "assistant":
			return convertAssistantMessage(message.content, modelId, signsThinking);
		default:
			throw new AIError.ValidationError("Unknown message role");
	}
}

function convertUserMessage(content: UserMessage["content"]): WireMessage | undefined {
	if (typeof content === "string") {
		return content.trim() === "" ? undefined : { role: "user", content: [{ text: content.toWellFormed() }] };
	}
	const blocks: UserContent[] = [];
	for (const block of content) {
		const converted = convertUserBlock(block);
		if (converted) blocks.push(converted);
	}
	return blocks.length > 0 ? { role: "user", content: blocks } : undefined;
}

function convertAssistantMessage(
	content: AssistantMessage["content"],
	modelId: string,
	signsThinking: boolean,
): WireMessage | undefined {
	const blocks: AssistantContent[] = [];
	for (const block of content) {
		const converted = convertAssistantBlock(block, modelId, signsThinking);
		if (converted) blocks.push(converted);
	}
	return blocks.length > 0 ? { role: "assistant", content: blocks } : undefined;
}

/** A user content block on the wire, or undefined for blank text. */
function convertUserBlock(block: TextContent | ImageContent): UserContent | undefined {
	switch (block.type) {
		case "text": {
			const text = block.text.toWellFormed();
			return text.trim().length === 0 ? undefined : { text };
		}
		case "image":
			return { image: createImageBlock(block.mimeType, block.data) };
		default:
			throw new AIError.ValidationError("Unknown user content type");
	}
}

/** An assistant content block on the wire, or undefined for blank text or blank thinking. */
function convertAssistantBlock(
	block: AssistantMessage["content"][number],
	modelId: string,
	signsThinking: boolean,
): AssistantContent | undefined {
	switch (block.type) {
		case "text":
			return block.text.trim().length === 0 ? undefined : { text: block.text.toWellFormed() };
		case "toolCall":
			return { toolUse: { toolUseId: normalizeToolCallId(block.id), name: block.name, input: block.arguments } };
		case "thinking": {
			if (block.thinking.trim().length === 0) return undefined;
			// A model that rejects the signature field gets unsigned reasoning. A model
			// that requires one rejects reasoningContent without it, so reasoning that
			// lost its signature (e.g., to an aborted stream) is demoted to text.
			if (signsThinking && !block.thinkingSignature) return { text: renderDemotedThinking(modelId, block.thinking) };
			const text = block.thinking.toWellFormed();
			const reasoningText = signsThinking ? { text, signature: block.thinkingSignature } : { text };
			return { reasoningContent: { reasoningText } };
		}
		default:
			throw new AIError.ValidationError("Unknown assistant content type");
	}
}

function convertToolResult(message: ToolResultMessage): ToolResultBlockWire {
	return {
		toolResult: {
			toolUseId: normalizeToolCallId(message.toolCallId),
			content: message.content.map(c =>
				c.type === "image" ? { image: createImageBlock(c.mimeType, c.data) } : { text: c.text.toWellFormed() },
			),
			status: message.isError ? "error" : "success",
		},
	};
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
