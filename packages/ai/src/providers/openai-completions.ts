import type { Effort } from "@veyyon/catalog/effort";
import { isKimiModelId } from "@veyyon/catalog/identity";
import { resolveReasoningSelection } from "@veyyon/catalog/model-thinking";
import { calculateCost, emptyCost } from "@veyyon/catalog/models";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";
import { $env } from "@veyyon/utils/env";
import { tryParseJson } from "@veyyon/utils/json";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts, resolveCacheRetention } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import {
	clearStreamingPartialJson,
	isDemotedThinking,
	kStreamingLastParseLen,
	setStreamingPartialJson,
} from "../utils/block-symbols";
import {
	EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE,
	hasVisibleAssistantContent,
	withEmptyCompletionRetry,
} from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	iterateWithTerminalGrace,
} from "../utils/idle-iterator";
import { OpenAIHttpError, type OpenAIStreamHandle, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT, normalizeSchemaForMoonshot, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "../utils/sse-debug";
import {
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import type { CacheControlEphemeral } from "./anthropic-wire";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
} from "./openai-chat-wire";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallbackState,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import {
	applyChatCompletionsCompatPolicy,
	applyChatCompletionsToolStream,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyOpenAIServiceTier,
	applyWireModelIdTransform,
	calculateOpenAIUsageAccounting,
	clearOpenAIStrictToolsState,
	createInitialResponsesAssistantMessage,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIStrictToolsScope,
	isCompiledGrammarTooLargeStrictError,
	isOpenRouterAnthropicModel,
	isStrictToolsDisabledForScope,
	type OpenAICompatPolicy,
	type OpenAICompletionsParams,
	type OpenAIRequestSetup,
	type OpenAIStrictToolsScope,
	type OpenAIStrictToolsState,
	parseAzureDeploymentNameMap,
	resolveOpenAICompatPolicy,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	resolveZaiReasoningOutputClamp,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";
import {
	isDashscopeCompatibleModeTextOnlyQwen,
	joinTextWithImagePlaceholder,
	NON_VISION_IMAGE_PLACEHOLDER,
} from "./vision-guard";

export { applyOpenRouterRoutingVariant } from "./openai-shared";

type OpenAICompletionsReasoningField = NonNullable<ResolvedOpenAICompat["reasoningContentField"]>;

type ProviderAttributedChatCompletionChunk = ChatCompletionChunk & {
	provider?: unknown;
};

type OpenAICompletionsChoiceUsage = ChatCompletionChunk.Choice & {
	usage?: unknown;
};

type OpenAICompletionsDeltaWithReasoningDetails = ChatCompletionChunk.Choice["delta"] & {
	reasoning_details?: unknown;
};

type OpenAICompletionsAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: unknown[];
	};

type OpenAICompletionsToolMessageParam = ChatCompletionToolMessageParam & {
	name?: string;
};

type OpenAICompletionsUsageLike = {
	completion_tokens?: unknown;
	prompt_tokens?: unknown;
	cached_tokens?: unknown;
	prompt_cache_hit_tokens?: unknown;
	prompt_cache_miss_tokens?: unknown;
	prompt_tokens_details?: unknown;
	completion_tokens_details?: unknown;
};

type OpenAICompletionsPromptTokenDetails = {
	cached_tokens?: unknown;
	cache_write_tokens?: unknown;
};

type OpenAICompletionsCompletionTokenDetails = {
	reasoning_tokens?: unknown;
};

function firstPositiveNumber(...values: unknown[]): number {
	for (const value of values) {
		if (typeof value === "number" && value > 0) return value;
	}
	return 0;
}

function hasPositiveCacheReadTokenField(rawUsage: object): boolean {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	if (typeof usageLike.cached_tokens === "number" && usageLike.cached_tokens > 0) return true;
	if (typeof usageLike.prompt_cache_hit_tokens === "number" && usageLike.prompt_cache_hit_tokens > 0) return true;

	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	if (typeof rawPromptTokenDetails !== "object" || rawPromptTokenDetails === null) return false;

	const promptTokenDetails = rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails;
	return typeof promptTokenDetails.cached_tokens === "number" && promptTokenDetails.cached_tokens > 0;
}

/** Normalize tool call ID for Mistral (requires exactly 9 alphanumeric chars). */
function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;
	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	if (normalized.length < 9) {
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}

function resolveOpenAICompletionsModelId(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): string {
	// Effort-tier variants route per request effort (off → bare id, efforts →
	// the thinking backing id); catalog variants (Copilot long-context `-1m`
	// entries) pin via `requestModelId`; everything else serializes `model.id`.
	const selection = resolveReasoningSelection(model, {
		effort: options?.reasoning as Effort | undefined,
		disabled: options?.disableReasoning,
	});
	const wireId = selection.wireModelId;
	return applyWireModelIdTransform(wireId, model.compat.wireModelIdMode, options?.openrouterVariant);
}

/**
 * Normalize OpenAI-compatible streaming `delta.content` into plain text.
 * Most providers stream `delta.content` as a string, but some (notably Mistral
 * Medium 3.5 / `mistral-medium-2604`) return an array of typed content parts
 * — e.g. `[{ type: "text", text: "Hello" }]`. Without normalization those
 * parts get string-coerced via `text += array`, producing the literal
 * `[object Object]` sequences observed in issue #911.
 *
 * Returns the joined text. Non-text parts and unknown shapes are skipped so
 * we never emit JS object sigils as visible output.
 */
function normalizeStreamingContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			if (typeof part === "string") {
				out += part;
			} else if (part && typeof part === "object") {
				const obj = part as { type?: unknown; text?: unknown };
				if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
					out += obj.text;
				}
			}
		}
		return out;
	}
	if (content && typeof content === "object") {
		const obj = content as { type?: unknown; text?: unknown };
		if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
			return obj.text;
		}
	}
	return "";
}

/**
 * Serialize a recorded tool call's arguments back into the JSON string the
 * provider expects when the conversation is replayed.
 *
 * The `arguments` field only has to be a string containing JSON, so any valid
 * JSON is preserved, not just an object: a stored array or scalar is still what
 * the model produced, and re-serializing it keeps the replayed history honest.
 * Dropping such a value to `{}` used to corrupt the model's view of its own
 * history (it would see it called the tool with no arguments) for no gain. The
 * `{}` safety net remains for a string that is not valid JSON at all, since a
 * strict provider rejects a non-JSON arguments string, but that drop is now
 * surfaced rather than swallowed (Law 10).
 */
export function serializeToolArguments(value: unknown, toolName?: string): string {
	if (isRecord(value)) {
		try {
			return JSON.stringify(value);
		} catch {
			return "{}";
		}
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return "{}";
		try {
			// Re-stringify so the output is canonical JSON, whether the parsed value
			// is an object, an array, or a scalar. All three are valid here.
			return JSON.stringify(JSON.parse(trimmed));
		} catch {
			logger.warn("A recorded tool call had unparseable arguments, replaced with {} when replayed to the provider", {
				...(toolName ? { tool: toolName } : {}),
				fix: "The model emitted arguments that are not valid JSON. The tool already ran, but its arguments are lost from the replayed history, which can confuse later turns. This usually points at a provider streaming malformed tool-call deltas.",
			});
			return "{}";
		}
	}

	return "{}";
}

function cloneStreamingArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneStreamingArgumentValue);
	}
	if (isRecord(value)) {
		return mergeStreamingArgumentObjects(undefined, value as Record<string, unknown>);
	}
	return value;
}

function streamingArgumentValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (!streamingArgumentValuesEqual(left[i], right[i])) return false;
		}
		return true;
	}
	if (
		left !== null &&
		typeof left === "object" &&
		!Array.isArray(left) &&
		right !== null &&
		typeof right === "object" &&
		!Array.isArray(right)
	) {
		const leftObject = left as Record<string, unknown>;
		const rightObject = right as Record<string, unknown>;
		let leftKeys = 0;
		for (const key in leftObject) {
			if (!Object.hasOwn(leftObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			leftKeys++;
			if (!Object.hasOwn(rightObject, key) || !streamingArgumentValuesEqual(leftObject[key], rightObject[key])) {
				return false;
			}
		}
		let rightKeys = 0;
		for (const key in rightObject) {
			if (!Object.hasOwn(rightObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			rightKeys++;
		}
		return leftKeys === rightKeys;
	}
	return false;
}

function streamingArgumentArrayStartsWith(value: unknown[], prefix: unknown[]): boolean {
	if (prefix.length > value.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!streamingArgumentValuesEqual(value[i], prefix[i])) return false;
	}
	return true;
}

function mergeStreamingArgumentArrays(prev: unknown[], fragment: unknown[]): unknown[] {
	if (streamingArgumentArrayStartsWith(fragment, prev)) {
		return fragment.map(cloneStreamingArgumentValue);
	}
	if (streamingArgumentArrayStartsWith(prev, fragment)) {
		return prev.map(cloneStreamingArgumentValue);
	}
	const merged = prev.map(cloneStreamingArgumentValue);
	for (const value of fragment) {
		merged.push(cloneStreamingArgumentValue(value));
	}
	return merged;
}

function mergeStreamingArgumentValues(prev: unknown, fragment: unknown): unknown {
	if (typeof prev === "string" && typeof fragment === "string") {
		return fragment.startsWith(prev) ? fragment : prev + fragment;
	}
	if (Array.isArray(prev) && Array.isArray(fragment)) {
		return mergeStreamingArgumentArrays(prev, fragment);
	}
	if (
		prev !== null &&
		typeof prev === "object" &&
		!Array.isArray(prev) &&
		fragment !== null &&
		typeof fragment === "object" &&
		!Array.isArray(fragment)
	) {
		return mergeStreamingArgumentObjects(prev as Record<string, unknown>, fragment as Record<string, unknown>);
	}
	return cloneStreamingArgumentValue(fragment);
}

function mergeStreamingArgumentObjects(
	prev: Record<string, unknown> | undefined,
	fragment: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (prev) {
		for (const key in prev) {
			if (!Object.hasOwn(prev, key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
			merged[key] = cloneStreamingArgumentValue(prev[key]);
		}
	}
	for (const key in fragment) {
		if (!Object.hasOwn(fragment, key) || key === "__proto__" || key === "constructor" || key === "prototype")
			continue;
		merged[key] = Object.hasOwn(merged, key)
			? mergeStreamingArgumentValues(merged[key], fragment[key])
			: cloneStreamingArgumentValue(fragment[key]);
	}
	return merged;
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some(block => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}
/**
 * Identify "real progress" stream chunks vs. keepalives, role-only preambles,
 * and empty `{choices:[]}` no-ops emitted by some OpenAI-compatible endpoints.
 * Without this filter, every keepalive resets `iterateWithIdleTimeout`'s
 * deadline, so a provider that streams nothing but pings keeps the watchdog
 * asleep indefinitely — observed against z.ai/GLM via OpenRouter where a
 * subagent stalled for hours with no error surfaced.
 *
 * A chunk counts as progress when it carries terminal usage, a finish reason,
 * or a model-produced delta (content / tool calls / reasoning / refusal).
 * Role-only `delta: { role: "assistant" }` preambles do NOT count; we want the
 * (longer) first-event timeout to keep governing until real output appears.
 */
export function isOpenAICompletionsProgressChunk(chunk: unknown): boolean {
	if (!chunk || typeof chunk !== "object") return false;
	const record = chunk as {
		usage?: unknown;
		choices?: ReadonlyArray<{
			finish_reason?: unknown;
			usage?: unknown;
			delta?: {
				content?: unknown;
				tool_calls?: unknown;
				reasoning?: unknown;
				reasoning_content?: unknown;
				reasoning_text?: unknown;
				refusal?: unknown;
			};
		}>;
	};
	if (record.usage) return true;
	const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
	if (!choice) return false;
	if (choice.finish_reason) return true;
	if (choice.usage) return true;
	const delta = choice.delta;
	if (!delta) return false;
	const content = delta.content;
	if (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0) return true;
	if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
	if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) return true;
	if (typeof delta.refusal === "string" && delta.refusal.length > 0) return true;
	return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Force-disable reasoning where supported, or request the lowest effort on generic effort endpoints. */
	disableReasoning?: boolean;
	serviceTier?: ServiceTier;
	/** @internal True when maxTokens came from the caller, not the model default. */
	maxTokensExplicit?: boolean;
	/**
	 * Routing-variant suffix appended to OpenRouter model IDs when none is
	 * already present (`anthropic/claude-haiku-latest` → `…:nitro`). Common
	 * values: `"nitro"`, `"floor"`, `"online"`, `"exacto"`. Ignored when the
	 * resolved `model.id` already contains a colon-suffix after the last
	 * provider segment (explicit `:nitro` in the selector or a catalog entry
	 * with the variant baked in).
	 */
	openrouterVariant?: string;
}

type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

type BuiltOpenAICompletionTools = {
	tools: ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;
	/** True when at least one wire tool was sent with `strict: true`. */
	strictToolsApplied: boolean;
};

const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

function openAICompletionsProviderSessionStateKey(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
): string {
	return `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${model.id}:${baseUrl ?? ""}`;
}

type OpenAICompletionsProviderSessionState = ProviderSessionState &
	OpenAIStrictToolsState &
	OpenAIReasoningEffortFallbackState;
function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAICompletionsProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		close: () => {
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
		},
	};
	return state;
}

function getOpenAICompletionsProviderSessionState(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = openAICompletionsProviderSessionStateKey(model, baseUrl);
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

function stripDeepseekSpecialTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
	if (stripped === text) return text;
	let normalized = stripped;
	if (DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
}

function getTrailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) return text.endsWith("<") ? "<" : "";
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";
	if (tail.length > 256) return "";
	return tail;
}

const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";
const OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS = 2_500;
type ToolCallStreamBlock = ToolCall & {
	partialArgs?: string | Record<string, unknown>;
	streamIndex?: number;
	[kStreamingLastParseLen]?: number;
};
type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;

interface OpenAICompletionsStreamContext {
	model: Model<"openai-completions">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	policy: ResolvedOpenAICompat;
	firstTokenTime?: number;
	currentBlock?: OpenAIStreamBlock;
	pendingToolCallBlocks: ToolCallStreamBlock[];
	toolCallBlockByIndex: Map<number, ToolCallStreamBlock>;
	unkeyedBatchBlocks: (ToolCallStreamBlock | undefined)[];
	lastCumulativeReasoningBySignature: Map<string, string>;
	deepseekStripBuffer: string;
	stripDeepseekChatTemplateTokens: boolean;
	streamMarkupHealing?: StreamMarkupHealing;
	explicitReasoningDeltasMayBeCumulative?: boolean;
	suppressHealedThinking: boolean;
	healedToolCallEmitted: boolean;
	streamFinishedAt?: number;
	sawUsagePayload: boolean;
	awaitTrailingUsageDetails: boolean;
	premiumRequestsTotal?: number;
}

function getOpenAICompletionsBlockIndex(
	ctx: OpenAICompletionsStreamContext,
	block: OpenAIStreamBlock | undefined,
): number {
	if (!block) return Math.max(0, ctx.output.content.length - 1);
	return ctx.output.content.indexOf(block);
}

function hasCompleteToolCallBatch(ctx: OpenAICompletionsStreamContext): boolean {
	const toolCalls = ctx.output.content.filter((block): block is ToolCallStreamBlock => block.type === "toolCall");
	if (toolCalls.length === 0) return false;
	return toolCalls.every(block => {
		if (!block.id || !block.name) return false;
		const argumentsValue =
			block.partialArgs === undefined
				? block.arguments
				: typeof block.partialArgs === "string"
					? tryParseJson(block.partialArgs)
					: block.partialArgs;
		return isRecord(argumentsValue);
	});
}

function finishOpenAICompletionsToolCallBlock(ctx: OpenAICompletionsStreamContext, block: ToolCallStreamBlock): void {
	if (block.partialArgs === undefined) return;
	const contentIndex = getOpenAICompletionsBlockIndex(ctx, block);
	if (contentIndex < 0) return;
	if (typeof block.partialArgs === "object" && !Array.isArray(block.partialArgs)) {
		const fullJson = JSON.stringify(block.partialArgs);
		if (fullJson.length > 0 && fullJson !== "{}") {
			ctx.stream.push({ type: "toolcall_delta", contentIndex, delta: fullJson, partial: ctx.output });
		}
	}
	block.arguments = typeof block.partialArgs === "string" ? parseStreamingJson(block.partialArgs) : block.partialArgs;
	delete block.partialArgs;
	clearStreamingPartialJson(block);
	if (block.streamIndex !== undefined) {
		ctx.toolCallBlockByIndex.delete(block.streamIndex);
		delete block.streamIndex;
	}
	const pendingIndex = ctx.pendingToolCallBlocks.indexOf(block);
	if (pendingIndex >= 0) ctx.pendingToolCallBlocks.splice(pendingIndex, 1);
	for (let index = 0; index < ctx.unkeyedBatchBlocks.length; index++) {
		if (ctx.unkeyedBatchBlocks[index] === block) ctx.unkeyedBatchBlocks[index] = undefined;
	}
	ctx.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: ctx.output });
}

function finishOpenAICompletionsCurrentBlock(
	ctx: OpenAICompletionsStreamContext,
	block: OpenAIStreamBlock | undefined,
): void {
	if (!block) return;
	const contentIndex = getOpenAICompletionsBlockIndex(ctx, block);
	if (contentIndex < 0) return;
	if (block.type === "text") {
		ctx.stream.push({ type: "text_end", contentIndex, content: block.text, partial: ctx.output });
		return;
	}
	if (block.type === "thinking") {
		ctx.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: ctx.output });
		return;
	}
	finishOpenAICompletionsToolCallBlock(ctx, block);
}

function finishOpenAICompletionsPendingToolCallBlocks(ctx: OpenAICompletionsStreamContext): void {
	for (const block of ctx.pendingToolCallBlocks.slice()) {
		finishOpenAICompletionsToolCallBlock(ctx, block);
	}
}

function appendOpenAICompletionsTextDelta(ctx: OpenAICompletionsStreamContext, text: string): void {
	if (!text) return;
	if (!ctx.firstTokenTime) ctx.firstTokenTime = performance.now();
	if (ctx.currentBlock?.type !== "text") {
		if (ctx.currentBlock?.type !== "toolCall") finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		ctx.currentBlock = { type: "text", text: "" };
		ctx.output.content.push(ctx.currentBlock);
		ctx.stream.push({
			type: "text_start",
			contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
			partial: ctx.output,
		});
	}
	ctx.currentBlock.text += text;
	ctx.stream.push({
		type: "text_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
		delta: text,
		partial: ctx.output,
	});
}

function appendOpenAICompletionsThinkingDelta(
	ctx: OpenAICompletionsStreamContext,
	thinking: string,
	signature?: string,
	source: "delta" | "cumulative" = "delta",
): void {
	if (!thinking) return;
	let emittedThinking = thinking;
	if (source === "cumulative") {
		const key = signature ?? "";
		const lastSnapshot = ctx.lastCumulativeReasoningBySignature.get(key) ?? "";
		if (thinking.startsWith(lastSnapshot)) {
			emittedThinking = thinking.slice(lastSnapshot.length);
		}
		ctx.lastCumulativeReasoningBySignature.set(key, thinking);
		if (!emittedThinking) return;
	}
	if (!ctx.firstTokenTime) ctx.firstTokenTime = performance.now();
	if (
		ctx.currentBlock?.type !== "thinking" ||
		(signature !== undefined && ctx.currentBlock.thinkingSignature !== signature)
	) {
		if (ctx.currentBlock?.type !== "toolCall") finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		ctx.currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
		ctx.output.content.push(ctx.currentBlock);
		ctx.stream.push({
			type: "thinking_start",
			contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
			partial: ctx.output,
		});
	}
	if (signature !== undefined && !ctx.currentBlock.thinkingSignature) {
		ctx.currentBlock.thinkingSignature = signature;
	}
	ctx.currentBlock.thinking += emittedThinking;
	ctx.stream.push({
		type: "thinking_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
		delta: emittedThinking,
		partial: ctx.output,
	});
}

function flushDeepseekStripBuffer(ctx: OpenAICompletionsStreamContext, final: boolean): void {
	if (ctx.deepseekStripBuffer.length === 0) return;
	let flushable: string;
	if (final) {
		flushable = ctx.deepseekStripBuffer;
		ctx.deepseekStripBuffer = "";
	} else {
		const trailing = getTrailingPartialDeepseekToken(ctx.deepseekStripBuffer);
		flushable = ctx.deepseekStripBuffer.slice(0, ctx.deepseekStripBuffer.length - trailing.length);
		ctx.deepseekStripBuffer = trailing;
	}
	const stripped = stripDeepseekSpecialTokens(flushable);
	if (stripped && (stripped === flushable || stripped.trim().length > 0))
		appendOpenAICompletionsTextDelta(ctx, stripped);
}

function appendOpenAICompletionsProcessedText(ctx: OpenAICompletionsStreamContext, processedText: string): void {
	if (processedText.length === 0) return;
	if (ctx.stripDeepseekChatTemplateTokens) {
		ctx.deepseekStripBuffer += processedText;
		flushDeepseekStripBuffer(ctx, false);
	} else {
		appendOpenAICompletionsTextDelta(ctx, processedText);
	}
}

function emitHealedToolCall(ctx: OpenAICompletionsStreamContext, call: HealedToolCall): void {
	finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
	const block: ToolCall & { partialArgs: string } = {
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: {},
		partialArgs: call.arguments,
	};
	block.arguments = parseStreamingJson(call.arguments);
	ctx.currentBlock = block;
	ctx.output.content.push(block);
	ctx.stream.push({
		type: "toolcall_start",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
		partial: ctx.output,
	});
	ctx.stream.push({
		type: "toolcall_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
		delta: call.arguments,
		partial: ctx.output,
	});
	finishOpenAICompletionsCurrentBlock(ctx, block);
	ctx.currentBlock = undefined;
	ctx.healedToolCallEmitted = true;
}

function emitHealingEvent(ctx: OpenAICompletionsStreamContext, event: StreamMarkupHealingEvent): void {
	if (event.type === "text") {
		appendOpenAICompletionsProcessedText(ctx, event.text);
	} else if (event.type === "thinking") {
		if (!ctx.suppressHealedThinking) appendOpenAICompletionsThinkingDelta(ctx, event.thinking);
	} else {
		emitHealedToolCall(ctx, event.call);
	}
}

function processOpenAICompletionsToolCallDelta(
	ctx: OpenAICompletionsStreamContext,
	toolCall: NonNullable<ChatCompletionChunk.Choice["delta"]["tool_calls"]>[number],
	toolCallOffset: number,
	toolCallsLength: number,
): void {
	const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
	const incomingName = toolCall.function?.name || "";
	const unkeyedBatchedArrayEntry = toolCallsLength > 1 && streamIndex === undefined && !toolCall.id;
	let block = streamIndex !== undefined ? ctx.toolCallBlockByIndex.get(streamIndex) : undefined;
	if (!block && toolCall.id) {
		block = ctx.pendingToolCallBlocks.find(candidate => candidate.id === toolCall.id);
	}
	if (!block && unkeyedBatchedArrayEntry) {
		const offsetBlock = ctx.unkeyedBatchBlocks[toolCallOffset];
		if (offsetBlock && offsetBlock.partialArgs !== undefined) block = offsetBlock;
	}
	if (
		!block &&
		!unkeyedBatchedArrayEntry &&
		ctx.currentBlock?.type === "toolCall" &&
		(!toolCall.id || ctx.currentBlock.id === toolCall.id)
	) {
		block = ctx.currentBlock;
	}

	if (!block) {
		if (ctx.currentBlock?.type !== "toolCall") {
			finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		}
		block = {
			type: "toolCall",
			id: toolCall.id || "",
			name: incomingName,
			arguments: {},
			partialArgs: "",
			streamIndex,
		};
		if (streamIndex !== undefined) ctx.toolCallBlockByIndex.set(streamIndex, block);
		ctx.pendingToolCallBlocks.push(block);
		ctx.currentBlock = block;
		ctx.output.content.push(block);
		ctx.stream.push({
			type: "toolcall_start",
			contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
			partial: ctx.output,
		});
		if (unkeyedBatchedArrayEntry) ctx.unkeyedBatchBlocks[toolCallOffset] = block;
	} else {
		if (ctx.currentBlock !== block && ctx.currentBlock && ctx.currentBlock.type !== "toolCall") {
			finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		}
		ctx.currentBlock = block;
		if (streamIndex !== undefined && block.streamIndex === undefined) {
			block.streamIndex = streamIndex;
			ctx.toolCallBlockByIndex.set(streamIndex, block);
		}
	}

	if (toolCall.id) block.id = toolCall.id;
	if (incomingName) block.name = incomingName;
	let delta = "";
	const rawArgs = toolCall.function?.arguments as string | Record<string, unknown> | undefined;
	if (typeof rawArgs === "string") {
		if (rawArgs.length > 0) {
			delta = rawArgs;
			const prev = typeof block.partialArgs === "string" ? block.partialArgs : "";
			block.partialArgs = prev + rawArgs;
			setStreamingPartialJson(block, block.partialArgs);
			const throttled = parseStreamingJsonThrottled(block.partialArgs, block[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				block.arguments = throttled.value;
				block[kStreamingLastParseLen] = throttled.parsedLen;
			}
		}
	} else if (isRecord(rawArgs)) {
		const prev =
			block.partialArgs !== null && typeof block.partialArgs === "object" && !Array.isArray(block.partialArgs)
				? (block.partialArgs as Record<string, unknown>)
				: undefined;
		const merged = mergeStreamingArgumentObjects(prev, rawArgs);
		block.partialArgs = merged;
		block.arguments = merged;
	}
	ctx.stream.push({
		type: "toolcall_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
		delta,
		partial: ctx.output,
	});
}

function processOpenAICompletionsChunk(chunk: ChatCompletionChunk, ctx: OpenAICompletionsStreamContext): boolean {
	if (!chunk || typeof chunk !== "object") return true;

	ctx.output.responseId ||= chunk.id;

	if (!ctx.output.upstreamProvider) {
		const upstreamProvider = (chunk as ProviderAttributedChatCompletionChunk).provider;
		ctx.output.upstreamProvider =
			typeof upstreamProvider === "string" && upstreamProvider.length > 0 ? upstreamProvider : undefined;
	}

	const applyUsage = (rawUsage: object) => {
		ctx.output.usage = parseChunkUsage(rawUsage, ctx.model, ctx.premiumRequestsTotal);
		ctx.sawUsagePayload = true;
		ctx.awaitTrailingUsageDetails = !hasPositiveCacheReadTokenField(rawUsage);
	};

	if (chunk.usage) applyUsage(chunk.usage);

	const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
	if (!choice) {
		if (ctx.sawUsagePayload && hasCompleteToolCallBatch(ctx)) {
			ctx.output.stopReason = "toolUse";
			ctx.streamFinishedAt ??= Date.now();
			return false;
		}
		if (ctx.streamFinishedAt !== undefined && ctx.sawUsagePayload) return false;
		return true;
	}

	if (!chunk.usage) {
		const choiceUsage = (choice as OpenAICompletionsChoiceUsage).usage;
		if (typeof choiceUsage === "object" && choiceUsage !== null) {
			applyUsage(choiceUsage);
		}
	}

	if (choice.finish_reason) {
		const finishReasonResult = mapStopReason(choice.finish_reason);
		ctx.output.stopReason = finishReasonResult.stopReason;
		if (finishReasonResult.errorMessage) {
			ctx.output.errorMessage = finishReasonResult.errorMessage;
		}
		ctx.streamFinishedAt ??= Date.now();
	}

	if (choice.delta) {
		processOpenAICompletionsDelta(choice.delta, ctx);
	}

	if (ctx.streamFinishedAt !== undefined && ctx.sawUsagePayload && !ctx.awaitTrailingUsageDetails) return false;
	return true;
}

function processOpenAICompletionsDelta(
	delta: ChatCompletionChunk.Choice["delta"],
	ctx: OpenAICompletionsStreamContext,
): void {
	const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
	const deltaRecord = delta as Record<string, unknown>;
	let foundReasoningField: string | undefined;
	let foundReasoningDelta = "";
	for (const field of reasoningFields) {
		const reasoningDelta = deltaRecord[field];
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			foundReasoningField = field;
			foundReasoningDelta = reasoningDelta;
			break;
		}
	}

	if (foundReasoningField) {
		appendOpenAICompletionsThinkingDelta(
			ctx,
			foundReasoningDelta,
			foundReasoningField,
			ctx.explicitReasoningDeltasMayBeCumulative ? "cumulative" : "delta",
		);
		ctx.suppressHealedThinking = true;
	}

	const normalizedDeltaText = normalizeStreamingContentText(delta.content);
	if (normalizedDeltaText.length > 0) {
		if (!ctx.firstTokenTime) ctx.firstTokenTime = performance.now();
		const hasStructuredToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;

		if (ctx.streamMarkupHealing) {
			const healingEvents = hasStructuredToolCalls
				? ctx.streamMarkupHealing.feedEventsWithoutCalls(normalizedDeltaText)
				: ctx.streamMarkupHealing.feedEvents(normalizedDeltaText);
			for (const event of healingEvents) {
				emitHealingEvent(ctx, event);
			}
		} else {
			appendOpenAICompletionsProcessedText(ctx, normalizedDeltaText);
		}
	}

	if (delta.tool_calls && delta.tool_calls.length > 0) {
		const toolCalls = delta.tool_calls;
		for (let toolCallOffset = 0; toolCallOffset < toolCalls.length; toolCallOffset++) {
			const toolCall = toolCalls[toolCallOffset]!;
			processOpenAICompletionsToolCallDelta(ctx, toolCall, toolCallOffset, toolCalls.length);
		}
	}

	const reasoningDetails = (delta as OpenAICompletionsDeltaWithReasoningDetails).reasoning_details;
	if (Array.isArray(reasoningDetails)) {
		for (const detail of reasoningDetails) {
			if (!detail || typeof detail !== "object") continue;
			const detailObject = detail as { type?: unknown; id?: unknown; data?: unknown };
			if (detailObject.type === "reasoning.encrypted" && detailObject.id && detailObject.data) {
				const matchingToolCall = ctx.output.content.find(b => b.type === "toolCall" && b.id === detailObject.id) as
					| ToolCall
					| undefined;
				if (matchingToolCall) {
					matchingToolCall.thoughtSignature = JSON.stringify(detailObject);
				}
			}
		}
	}
	if (ctx.streamFinishedAt !== undefined && ctx.sawUsagePayload && !ctx.awaitTrailingUsageDetails) return false;
	return true;
}

function finalizeOpenAICompletionsStream(ctx: OpenAICompletionsStreamContext): void {
	if (ctx.streamFinishedAt === undefined) {
		const stopReason = stopReasonForTerminallessEof(ctx.output.content, hasCompleteToolCallBatch(ctx));
		if (stopReason === undefined) {
			throw new AIError.ProviderResponseError(
				"OpenAI completions stream closed before a terminal finish reason was received",
				{ provider: ctx.model.provider, kind: "incomplete-stream" },
			);
		}
		ctx.output.stopReason = stopReason;
		ctx.streamFinishedAt = Date.now();
	}

	if (ctx.streamMarkupHealing) {
		for (const event of ctx.streamMarkupHealing.flushEvents()) {
			emitHealingEvent(ctx, event);
		}
		const calls = ctx.streamMarkupHealing.drainCompleted();
		for (const call of calls) emitHealedToolCall(ctx, call);
		if (ctx.healedToolCallEmitted && ctx.output.stopReason === "stop") {
			ctx.output.stopReason = "toolUse";
		}
	}

	if (ctx.stripDeepseekChatTemplateTokens) {
		flushDeepseekStripBuffer(ctx, true);
	}

	if (ctx.currentBlock?.type === "toolCall") {
		finishOpenAICompletionsPendingToolCallBlocks(ctx);
	} else {
		finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		finishOpenAICompletionsPendingToolCallBlocks(ctx);
	}

	if (ctx.output.stopReason === "stop" && ctx.output.content.some(b => b.type === "toolCall")) {
		ctx.output.stopReason = "toolUse";
	}

	if (
		ctx.policy.stream.emptyLengthFinishIsContextError &&
		ctx.output.stopReason === "length" &&
		!hasVisibleAssistantContent(ctx.output)
	) {
		ctx.output.stopReason = "error";
		ctx.output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
	}

	if (ctx.output.stopReason === "aborted") {
		throw new AIError.RequestAbortError();
	}
	if (ctx.output.stopReason === "error") {
		throw new AIError.ProviderResponseError(ctx.output.errorMessage || "Provider returned an error stop reason", {
			provider: ctx.model.provider,
			kind: "runtime",
		});
	}
	ctx.output.errorMessage = undefined;
}

async function resolveInitialCompletionsStream(
	createCompletionsStream: (
		toolStrictModeOverride?: ToolStrictModeOverride,
		captureOnly?: boolean,
		currentDisableStrict?: boolean,
	) => Promise<OpenAIStreamHandle<ChatCompletionChunk>>,
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	requestSignal: AbortSignal,
	state: {
		appliedStrictTools: boolean;
		requestReasoningEffortFallbacks: Map<string, OpenAIReasoningEffortFallback>;
		attemptedReasoningEffortFallbacks: Set<string>;
		activeReasoningEffortFallbackKey?: string;
		activeRequestParams?: OpenAICompletionsParams;
		providerSessionState?: OpenAICompletionsProviderSessionState;
		strictToolsScope: OpenAIStrictToolsScope;
		disableStrictTools: boolean;
	},
): Promise<{ openaiHandle: OpenAIStreamHandle<ChatCompletionChunk>; disableStrictTools: boolean }> {
	if (requestSignal.aborted) await createCompletionsStream(undefined, true);
	try {
		const openaiHandle = await callWithCopilotModelRetry(() => createCompletionsStream(), {
			provider: model.provider,
			signal: requestSignal,
		});
		return { openaiHandle, disableStrictTools: state.disableStrictTools };
	} catch (error) {
		const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
		const reasoningEffortFallback =
			state.activeReasoningEffortFallbackKey && state.activeRequestParams && !requestSignal.aborted
				? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, state.activeRequestParams, {
						explicitDisable: options?.disableReasoning === true && options.reasoning === undefined,
					})
				: undefined;
		if (reasoningEffortFallback !== undefined && state.activeReasoningEffortFallbackKey) {
			const retryMarker = `${state.activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
			if (state.attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
			state.attemptedReasoningEffortFallbacks.add(retryMarker);
			state.requestReasoningEffortFallbacks.set(state.activeReasoningEffortFallbackKey, reasoningEffortFallback);
			const openaiHandle = await createCompletionsStream(undefined, false, state.disableStrictTools);
			rememberOpenAIReasoningEffortFallback(
				state.providerSessionState,
				state.activeReasoningEffortFallbackKey,
				reasoningEffortFallback,
			);
			return { openaiHandle, disableStrictTools: state.disableStrictTools };
		}
		if (
			isOpenRouterAnthropicModel(model) &&
			!state.disableStrictTools &&
			isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse)
		) {
			disableStrictToolsForScope(state.providerSessionState, state.strictToolsScope);
			state.disableStrictTools = true;
			const openaiHandle = await createCompletionsStream("none", false, true);
			return { openaiHandle, disableStrictTools: true };
		}
		if (!shouldRetryWithoutStrictTools(error, capturedErrorResponse, state.appliedStrictTools, context.tools)) {
			throw error;
		}
		disableStrictToolsForScope(state.providerSessionState, state.strictToolsScope);
		state.disableStrictTools = true;
		const openaiHandle = await createCompletionsStream("none", false, true);
		return { openaiHandle, disableStrictTools: true };
	}
}

const streamOpenAICompletionsOnce = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const policy = resolveOpenAICompatForRequest(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let wireBodyJson: string | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
			OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
		);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const modelSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;
		const rawSseObserver = modelSseObserver
			? (event: RawSseEvent) => {
					resolveOpenAiSseEventName(event);
					notifyRawSseEvent(modelSseObserver, event);
				}
			: undefined;
		let finishOpenBlocksOnError: () => void = () => {};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutFallbackMs = model.compat.streamIdleTimeoutMs;
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(idleTimeoutFallbackMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const { copilotPremiumRequests, baseUrl, headers, query, requestHeaders } = createRequestSetup(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				getOpenAIPromptCacheKey(options),
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			let disableStrictTools = isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
			const state = {
				appliedStrictTools: false,
				requestReasoningEffortFallbacks: new Map<string, OpenAIReasoningEffortFallback>(),
				attemptedReasoningEffortFallbacks: new Set<string>(),
				activeReasoningEffortFallbackKey: undefined as string | undefined,
				activeRequestParams: undefined as OpenAICompletionsParams | undefined,
				providerSessionState,
				strictToolsScope,
				disableStrictTools,
			};
			const trimmedBaseUrl = trimTrailingSlashes(baseUrl);
			const completionsUrl = query
				? `${trimmedBaseUrl}/chat/completions?${new URLSearchParams(query)}`
				: `${trimmedBaseUrl}/chat/completions`;

			const createCompletionsStream = async (
				toolStrictModeOverride?: ToolStrictModeOverride,
				captureOnly = false,
				currentDisableStrict = state.disableStrictTools,
			) => {
				const effectiveToolStrictModeOverride = currentDisableStrict ? "none" : toolStrictModeOverride;
				const { params, strictToolsApplied } = buildParams(
					model,
					context,
					options,
					effectiveToolStrictModeOverride,
				);
				state.appliedStrictTools = strictToolsApplied;
				const reasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
					"chat-completions",
					trimmedBaseUrl,
					params.model,
				);
				const requestReasoningEffortFallback = state.requestReasoningEffortFallbacks.has(reasoningEffortFallbackKey)
					? state.requestReasoningEffortFallbacks.get(reasoningEffortFallbackKey)
					: getOpenAIReasoningEffortFallback(providerSessionState, reasoningEffortFallbackKey);
				if (requestReasoningEffortFallback !== undefined) {
					applyOpenAIReasoningEffortFallback(params, requestReasoningEffortFallback);
				}
				state.activeReasoningEffortFallbackKey = reasoningEffortFallbackKey;
				const prepareRequest = async (): Promise<RequestInit> => {
					const bodyJson = JSON.stringify(params);
					let wireParams = params;
					if (options?.onPayload) {
						const attemptParams = JSON.parse(bodyJson) as OpenAICompletionsParams;
						const replacementPayload = await options.onPayload(attemptParams, model);
						wireParams =
							replacementPayload !== undefined && replacementPayload !== attemptParams
								? (replacementPayload as OpenAICompletionsParams)
								: attemptParams;
					}
					state.activeRequestParams = wireParams;
					const body = wireParams === params ? bodyJson : JSON.stringify(wireParams);
					rawRequestDump = {
						provider: model.provider,
						api: output.api,
						model: model.id,
						method: "POST",
						url: completionsUrl,
						headers: requestHeaders,
					};
					wireBodyJson = body;
					return { body };
				};
				if (captureOnly) {
					await prepareRequest();
					throw new AIError.RequestAbortError();
				}
				let requestTimeout: NodeJS.Timeout | undefined;
				if (requestTimeoutMs !== undefined) {
					requestTimeout = setTimeout(
						() => abortTracker.abortLocally(firstEventTimeoutAbortError),
						requestTimeoutMs,
					);
				}
				try {
					const headersWithTimeout = { ...headers };
					if (requestTimeoutMs !== undefined) {
						headersWithTimeout["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
					}
					const handle = await postOpenAIStream<ChatCompletionChunk>({
						url: completionsUrl,
						headers: headersWithTimeout,
						body: undefined,
						signal: requestSignal,
						fetch: options?.fetch,
						prepareInit: prepareRequest,
						maxRetryDelayMs: options?.maxRetryDelayMs,
						onSseEvent: rawSseObserver,
					});
					return handle;
				} finally {
					clearTimeout(requestTimeout);
				}
			};

			const initialStreamResult = await resolveInitialCompletionsStream(
				createCompletionsStream,
				model,
				context,
				options,
				requestSignal,
				state,
			);
			const openaiHandle = initialStreamResult.openaiHandle;
			disableStrictTools = initialStreamResult.disableStrictTools;
			await notifyProviderResponse(options, openaiHandle.response, model, openaiHandle.requestId);
			const openaiStream = openaiHandle.events;
			if (premiumRequestsTotal !== undefined) {
				output.usage.premiumRequests = premiumRequestsTotal;
			}
			stream.push({ type: "start", partial: output });

			const streamMarkupHealingPattern = policy.stream.markupHealingPattern;
			const streamMarkupHealing = streamMarkupHealingPattern
				? new StreamMarkupHealing({ pattern: streamMarkupHealingPattern })
				: undefined;

			const streamCtx: OpenAICompletionsStreamContext = {
				model,
				output,
				stream,
				policy,
				firstTokenTime,
				pendingToolCallBlocks: [],
				toolCallBlockByIndex: new Map(),
				unkeyedBatchBlocks: [],
				lastCumulativeReasoningBySignature: new Map(),
				deepseekStripBuffer: "",
				stripDeepseekChatTemplateTokens: policy.stream.stripSpecialTokens === "deepseek",
				streamMarkupHealing,
				explicitReasoningDeltasMayBeCumulative: policy.stream.reasoningDeltasMayBeCumulative,
				suppressHealedThinking: false,
				healedToolCallEmitted: false,
				sawUsagePayload: false,
				awaitTrailingUsageDetails: false,
				premiumRequestsTotal,
			};

			finishOpenBlocksOnError = () => {
				if (streamCtx.currentBlock?.type !== "toolCall")
					finishOpenAICompletionsCurrentBlock(streamCtx, streamCtx.currentBlock);
				finishOpenAICompletionsPendingToolCallBlocks(streamCtx);
			};

			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				abortSignal: options?.signal,
				isProgressItem: isOpenAICompletionsProgressChunk,
			});
			const terminalAwareStream = iterateWithTerminalGrace(timedOpenaiStream, {
				finishedAtMs: () => streamCtx.streamFinishedAt,
				graceMs: OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS,
				onGraceEnd: () => requestAbortController.abort(),
			});

			for await (const chunk of terminalAwareStream) {
				const shouldContinue = processOpenAICompletionsChunk(chunk, streamCtx);
				if (!shouldContinue) break;
			}

			firstTokenTime = streamCtx.firstTokenTime;

			const localAbortReason = abortTracker.getLocalAbortReason();
			if (localAbortReason) throw localAbortReason;
			if (abortTracker.wasCallerAbort()) throw new AIError.RequestAbortError();

			finalizeOpenAICompletionsStream(streamCtx);

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			try {
				finishOpenBlocksOnError();
			} catch {
				// Deliberate: the terminal error event below is what the caller needs.
			}
			const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker,
				rawRequestDump: materializeDumpBody(rawRequestDump, wireBodyJson),
				capturedErrorResponse,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Public entry: wrap the single-attempt streamer with bounded empty-completion
 * retries — flaky gateways occasionally 200 with `delta: {}` + `finish_reason:
 * "stop"` and no usage, which would otherwise stall the agent loop. Shared with
 * the Anthropic provider via `withEmptyCompletionRetry`.
 */
export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAICompletionsOnce);

function createRequestSetup(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	promptCacheSessionId?: string,
): OpenAIRequestSetup & { baseUrl: string } {
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
	const deploymentName = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id) ?? model.id;
	const setup = resolveOpenAIRequestSetup(model, {
		apiKey,
		extraHeaders,
		initiatorOverride,
		promptCacheSessionId,
		messages: context.messages,
		defaultBaseUrl: "https://api.openai.com/v1",
		// Provider auth/header overlay: Kimi-code hosts require shared client
		// attribution headers prepended before caller headers. Kept here (not in
		// the shared helper) because it is provider-specific request setup.
		prependHeaders: model.provider === "kimi-code" ? getKimiCommonHeaders : undefined,
		alibabaCodingPlanAuth: true,
		azureChatCompletions: { apiVersion, deploymentName },
	});
	if (!setup.baseUrl) {
		throw new AIError.ConfigurationError("OpenAI request setup did not resolve a base URL");
	}
	return setup as OpenAIRequestSetup & { baseUrl: string };
}

function resolveOpenAICompatForRequest(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): OpenAICompatPolicy {
	return resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: mapToOpenAICompletionsToolChoice(options?.toolChoice),
	});
}

function dropOpenRouterKimiForcedToolReasoning(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
): void {
	if (
		policy.reasoning.disableReason === "forced-tool-choice" &&
		policy.reasoning.disableMode === "openrouter-enabled-false" &&
		policy.compat.isOpenRouterHost &&
		isKimiModelId(model.id)
	) {
		delete params.reasoning;
	}
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	toolStrictModeOverride?: ToolStrictModeOverride,
): {
	params: OpenAICompletionsParams;
	toolStrictMode: AppliedToolStrictMode;
	strictToolsApplied: boolean;
} {
	const initialPolicy = resolveOpenAICompatForRequest(model, options);
	const initialCompat = initialPolicy.compat as ResolvedOpenAICompat;

	const requestModelId = resolveOpenAICompletionsModelId(model, options);
	const params: OpenAICompletionsParams = {
		model: requestModelId,
		messages: [],
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";
	let strictToolsApplied = false;

	if (initialCompat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (initialCompat.supportsStore) {
		params.store = false;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.minP !== undefined) {
		params.min_p = options.minP;
	}
	if (options?.presencePenalty !== undefined) {
		params.presence_penalty = options.presencePenalty;
	}
	if (options?.repetitionPenalty !== undefined) {
		params.repetition_penalty = options.repetitionPenalty;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
	if (options?.frequencyPenalty !== undefined) {
		params.frequency_penalty = options.frequencyPenalty;
	}
	applyOpenAIServiceTier(params, options?.serviceTier, model);

	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, initialCompat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
		strictToolsApplied = builtTools.strictToolsApplied;
	} else if (context.tools === undefined && hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires the `tools` param when the conversation
		// contains tool_calls/tool_results, even when no tools are offered this turn.
		// Only inject the sentinel when the caller passed `context.tools = undefined`
		// (i.e. tools were not specified at all). An explicit `context.tools = []` means
		// the caller opted out of tools for this turn (as /btw and IRC background replies
		// do via AgentSession.runEphemeralTurn) — honour that intent and emit nothing,
		// so LiteLLM → Bedrock never sees an empty `toolConfig` block.
		params.tools = [];
	}

	if (options?.toolChoice && initialCompat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}
	if (
		typeof params.tool_choice === "object" &&
		params.tool_choice !== null &&
		!initialCompat.supportsNamedToolChoice
	) {
		params.tool_choice = "required";
	}
	if (isForcedToolChoice(params.tool_choice) && !initialCompat.supportsForcedToolChoice) {
		// Some thinking-required OpenAI-compatible models reject forced
		// `tool_choice` while still accepting tools with the default auto
		// selector. Keep the tool available and let the model choose it.
		params.tool_choice = "auto";
	}

	if (params.tool_choice === "none" && (!Array.isArray(params.tools) || params.tools.length === 0)) {
		// `tool_choice: "none"` with no tools to gate is redundant and also
		// trips LiteLLM → Bedrock: the proxy serializes the directive into a
		// `toolConfig` block, and Bedrock requires `toolConfig.tools` to be
		// non-empty whenever the conversation already holds `toolUse`/`toolResult`
		// content. Drop it whenever the resolved tools list is missing or empty.
		// Side-channel turns hit this: `/btw` and IRC background replies route
		// through `AgentSession.runEphemeralTurn`, which sets `context.tools = []`
		// and `toolChoice: "none"` (see packages/coding-agent/src/session/agent-session.ts).
		delete params.tool_choice;
	}

	const forcedToolName =
		typeof params.tool_choice === "object" && params.tool_choice !== null && "function" in params.tool_choice
			? params.tool_choice.function.name
			: undefined;
	if (
		forcedToolName !== undefined &&
		(!Array.isArray(params.tools) ||
			!params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName))
	) {
		// A forced named tool_choice is only valid when the same request offers
		// that function in `tools`. Active-tool filtering normally enforces this
		// before provider dispatch; this guard keeps raw provider callers from
		// emitting a self-inconsistent OpenAI-compatible payload.
		delete params.tool_choice;
	}

	const finalPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
	});
	const compat = finalPolicy.compat as ResolvedOpenAICompat;
	const messages = convertMessages(model, context, compat);
	maybeAddAnthropicCacheControl(compat, messages, resolveCacheRetention(options?.cacheRetention));
	params.messages = messages;
	const outputToken = resolveOpenAIOutputTokenParam({
		field: compat.maxTokensField,
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		routedUpstreamSelfCaps: compat.routedUpstreamSelfCaps,
		alwaysSendMaxTokens: compat.alwaysSendMaxTokens,
		providerOutputClamp: resolveZaiReasoningOutputClamp(model, compat),
	});
	if (outputToken) {
		if (outputToken.field === "max_tokens") {
			params.max_tokens = outputToken.value;
		} else if (outputToken.field === "max_completion_tokens") {
			params.max_completion_tokens = outputToken.value;
		}
	}
	applyChatCompletionsToolStream(params, model, compat);

	applyChatCompletionsCompatPolicy(params, finalPolicy);
	dropOpenRouterKimiForcedToolReasoning(params, model, finalPolicy);

	applyOpenAIGatewayRouting(params, compat);

	applyOpenAIExtraBody(params, compat.extraBody, {
		dropThinkingWhenReasoningEffort: compat.dropThinkingWhenReasoningEffort,
	});

	return { params, toolStrictMode, strictToolsApplied };
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	premiumRequests: number | undefined,
): AssistantMessage["usage"] {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	const promptTokenDetails =
		typeof rawPromptTokenDetails === "object" && rawPromptTokenDetails !== null
			? (rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails)
			: undefined;
	const rawCompletionTokenDetails = usageLike.completion_tokens_details;
	const completionTokenDetails =
		typeof rawCompletionTokenDetails === "object" && rawCompletionTokenDetails !== null
			? (rawCompletionTokenDetails as OpenAICompletionsCompletionTokenDetails)
			: undefined;
	const completionTokens = usageLike.completion_tokens;
	const promptTokens = usageLike.prompt_tokens;
	const cachedTokens = usageLike.cached_tokens;
	const promptCacheHitTokens = usageLike.prompt_cache_hit_tokens;
	const promptCacheMissTokens = usageLike.prompt_cache_miss_tokens;
	const promptTokenCachedTokens = promptTokenDetails?.cached_tokens;
	const completionReasoningTokens = completionTokenDetails?.reasoning_tokens;
	const cacheWriteTokens = promptTokenDetails?.cache_write_tokens;
	const outputTokens = typeof completionTokens === "number" ? completionTokens : 0;
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
		outputTokens,
		cachedTokens: firstPositiveNumber(cachedTokens, promptCacheHitTokens, promptTokenCachedTokens),
		reasoningTokens: typeof completionReasoningTokens === "number" ? completionReasoningTokens : 0,
		cacheWriteOpenRouter: typeof cacheWriteTokens === "number" ? cacheWriteTokens : undefined,
		cacheWriteDeepSeek: typeof promptCacheMissTokens === "number" ? promptCacheMissTokens : undefined,
		hasDeepSeekCacheHitAndMiss: typeof promptCacheHitTokens === "number" && typeof promptCacheMissTokens === "number",
	});
	const usage: AssistantMessage["usage"] = {
		...accounting,
		cost: emptyCost(),
		...(premiumRequests !== undefined ? { premiumRequests } : {}),
	};
	calculateCost(model, usage);
	return usage;
}

/**
 * Place the single Anthropic-style breakpoint for an OpenAI-compatible payload.
 *
 * `cacheRetention` is a cross-provider request option, and every other
 * implementation of this idea consumes it: the Anthropic provider
 * (`getCacheControl`), Bedrock (`buildSystemPrompt` / `convertMessages`), and
 * the Responses path for the very same OpenRouter Claude rows
 * (`maybeAddOpenRouterAnthropicCacheControl`). This path ignored it entirely,
 * so `none` still wrote a breakpoint and paid the cache-write premium a caller
 * had opted out of, and `long` silently degraded to the default five-minute
 * window while the Responses path for the same model asked for an hour.
 */
function maybeAddAnthropicCacheControl(
	compat: ResolvedOpenAICompat,
	messages: ChatCompletionMessageParam[],
	cacheRetention: CacheRetention,
): void {
	if (compat.cacheControlFormat !== "anthropic") return;
	if (cacheRetention === "none") return;
	const cacheControl: CacheControlEphemeral =
		cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
	// Anthropic-style caching requires cache_control on a text part. Add a breakpoint
	// on the last user/assistant message (walking backwards until we find text content).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") continue;

		const content = msg.content;
		if (typeof content === "string") {
			if (content.trim().length === 0) continue;
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { ...cacheControl } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		// Find last non-empty text part and add cache_control. Empty assistant
		// content is valid for tool-call replay, but Anthropic/OpenRouter reject
		// empty text blocks once cache_control turns it into structured content.
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text" && part.text.trim().length > 0) {
				Object.assign(part, { cache_control: { ...cacheControl } });
				return;
			}
		}
	}
}

function convertUserOrDeveloperMessage(
	msg: Extract<Message, { role: "user" | "developer" }>,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const devAsUser = !compat.supportsDeveloperRole;
	const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
	if (typeof msg.content === "string") {
		const text = msg.content.toWellFormed();
		if (text.trim().length === 0) return [];
		return [{ role, content: text }];
	}
	const supportsImages = model.input.includes("image") && !isDashscopeCompatibleModeTextOnlyQwen(model);
	const content: ChatCompletionContentPart[] = [];
	let omittedImages = false;
	for (const item of msg.content) {
		if (item.type === "text") {
			const text = item.text.toWellFormed();
			if (text.trim().length === 0) continue;
			content.push({ type: "text", text } satisfies ChatCompletionContentPartText);
		} else if (supportsImages) {
			content.push({
				type: "image_url",
				image_url: {
					url: `data:${item.mimeType};base64,${item.data}`,
					...(item.detail && item.detail !== "original" ? { detail: item.detail } : {}),
				},
			} satisfies ChatCompletionContentPartImage);
		} else {
			omittedImages = true;
		}
	}
	if (omittedImages) {
		content.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER } satisfies ChatCompletionContentPartText);
	}
	if (content.length === 0) return [];
	if (msg.role === "developer" && role === "developer" && !msg.content.some(item => item.type === "image")) {
		return [
			{
				role: "developer",
				content: content
					.filter((item): item is ChatCompletionContentPartText => item.type === "text")
					.map(item => item.text)
					.join("\n"),
			},
		];
	}
	return [{ role: "user", content }];
}

function applyAssistantReasoningFields(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	msg: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	nonEmptyThinkingBlocks: ThinkingContent[],
	toolCalls: ToolCall[],
): void {
	if (nonEmptyThinkingBlocks.length > 0) {
		if (compat.requiresThinkingAsText) {
			const thinkingText = nonEmptyThinkingBlocks.map(b => renderDemotedThinking(model.id, b.thinking)).join(" ");
			assistantMsg.content =
				typeof assistantMsg.content === "string" && assistantMsg.content.length > 0
					? `${thinkingText} ${assistantMsg.content}`
					: thinkingText;
		} else if (compat.requiresReasoningContentForToolCalls) {
			const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
			const wireField =
				compat.allowsSyntheticReasoningContentForToolCalls &&
				(signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text")
					? signature
					: signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
						? (compat.reasoningContentField ?? "reasoning_content")
						: undefined;
			if (wireField) {
				assistantMsg[wireField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
			}
		} else if (compat.thinkingFormat === "zai" && model.reasoning) {
			const reasoningField = compat.reasoningContentField ?? "reasoning_content";
			assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
		} else if (compat.replayReasoningContent) {
			const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
			const reasoningField: OpenAICompletionsReasoningField =
				signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
					? signature
					: (compat.reasoningContentField ?? "reasoning_content");
			assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
		}
	}

	if (compat.requiresReasoningContentForToolCalls) {
		const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
		const reasoningField =
			compat.allowsSyntheticReasoningContentForToolCalls &&
			(streamedReasoningField === "reasoning_content" ||
				streamedReasoningField === "reasoning" ||
				streamedReasoningField === "reasoning_text")
				? streamedReasoningField
				: (compat.reasoningContentField ?? "reasoning_content");
		const reasoningContent = assistantMsg[reasoningField];
		if (!reasoningContent) {
			const reasoning = assistantMsg.reasoning;
			const reasoningText = assistantMsg.reasoning_text;
			if (reasoning && reasoningField !== "reasoning") {
				assistantMsg[reasoningField] = reasoning;
			} else if (reasoningText && reasoningField !== "reasoning_text") {
				assistantMsg[reasoningField] = reasoningText;
			} else if (nonEmptyThinkingBlocks.length > 0) {
				assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
			}
		}
	}

	applySyntheticOrFallbackReasoning(assistantMsg, msg, compat, toolCalls);
}

function applySyntheticOrFallbackReasoning(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	msg: AssistantMessage,
	compat: ResolvedOpenAICompat,
	toolCalls: ToolCall[],
): void {
	const canUseSyntheticReasoningContent =
		compat.requiresReasoningContentForToolCalls &&
		compat.allowsSyntheticReasoningContentForToolCalls &&
		(compat.thinkingFormat === "openai" || compat.thinkingFormat === "openrouter" || compat.thinkingFormat === "zai");
	const needsReasoningOnAllTurns = compat.requiresReasoningContentForAllAssistantTurns;
	const needsReasoningField = needsReasoningOnAllTurns || toolCalls.length > 0;
	let hasReasoningField =
		assistantMsg.reasoning_content !== undefined ||
		assistantMsg.reasoning !== undefined ||
		assistantMsg.reasoning_text !== undefined;

	if (
		needsReasoningField &&
		!hasReasoningField &&
		compat.requiresReasoningContentForToolCalls &&
		!compat.allowsSyntheticReasoningContentForToolCalls
	) {
		const allThinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
		if (allThinkingBlocks.length > 0) {
			const signature = allThinkingBlocks[0].thinkingSignature;
			if (signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text") {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				assistantMsg[reasoningField] = allThinkingBlocks.map(b => b.thinking).join("\n");
				hasReasoningField = true;
			}
		}
	}
	if (
		needsReasoningField &&
		!hasReasoningField &&
		compat.requiresReasoningContentForToolCalls &&
		!compat.allowsSyntheticReasoningContentForToolCalls
	) {
		const reasoningField = compat.reasoningContentField ?? "reasoning_content";
		assistantMsg[reasoningField] = "";
		hasReasoningField = true;
	}
	if (toolCalls.length > 0 && canUseSyntheticReasoningContent && !hasReasoningField) {
		const reasoningField = compat.reasoningContentField ?? "reasoning_content";
		assistantMsg[reasoningField] = ".";
	}
}
function convertAssistantMessage(
	msg: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	msgIndex: number,
	idTracker: {
		ensureToolCallId: (rawId: string, seed: string) => string;
		rememberToolCallId: (originalId: string, normalizedId: string) => void;
	},
): OpenAICompletionsAssistantMessageParam | null {
	const assistantMsg: OpenAICompletionsAssistantMessageParam = {
		role: "assistant",
		content: null,
	};

	const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];
	const nonEmptyTextBlocks = textBlocks.filter(b => b.text && b.text.trim().length > 0);
	if (nonEmptyTextBlocks.length > 0) {
		assistantMsg.content = nonEmptyTextBlocks
			.map((b, i) => {
				const text = b.text.toWellFormed();
				return isDemotedThinking(b) && i < nonEmptyTextBlocks.length - 1 ? `${text}\n` : text;
			})
			.join("");
	}

	const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
	const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking && b.thinking.trim().length > 0);
	const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];

	applyAssistantReasoningFields(assistantMsg, msg, model, compat, nonEmptyThinkingBlocks, toolCalls);

	if (toolCalls.length > 0) {
		assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
			const toolCallId = idTracker.ensureToolCallId(tc.id, `${msgIndex}:${toolCallIndex}:${tc.name}`);
			idTracker.rememberToolCallId(tc.id, toolCallId);
			return {
				id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
				type: "function" as const,
				function: {
					name: tc.name,
					arguments: serializeToolArguments(tc.arguments, tc.name),
				},
			};
		});
		const reasoningDetails = toolCalls
			.filter(tc => tc.thoughtSignature)
			.map(tc => tryParseJson(tc.thoughtSignature!))
			.filter(Boolean);
		if (reasoningDetails.length > 0) {
			assistantMsg.reasoning_details = reasoningDetails;
		}
	}

	const hasReasoningField =
		assistantMsg.reasoning_content !== undefined ||
		assistantMsg.reasoning !== undefined ||
		assistantMsg.reasoning_text !== undefined;

	if (assistantMsg.content === null && (hasReasoningField || assistantMsg.tool_calls)) {
		assistantMsg.content = "";
	}
	const content = assistantMsg.content;
	const hasContent =
		content !== null &&
		content !== undefined &&
		(typeof content === "string" ? content.length > 0 : content.length > 0);
	if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
		assistantMsg.content = ".";
	}
	if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
		return null;
	}
	return assistantMsg;
}

function convertToolResultBatch(
	transformedMessages: Message[],
	startIndex: number,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	idTracker: {
		consumeToolCallId: (originalId: string) => string | null;
		ensureToolCallId: (rawId: string, seed: string) => string;
	},
): {
	params: ChatCompletionMessageParam[];
	nextIndex: number;
	lastRole: string;
} {
	const params: ChatCompletionMessageParam[] = [];
	const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
	let j = startIndex;

	for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
		const toolMsg = transformedMessages[j] as ToolResultMessage;
		const textResult = toolMsg.content
			.filter(c => c.type === "text")
			.map(c => (c as TextContent).text)
			.join("\n");
		const supportsImages = model.input.includes("image") && !isDashscopeCompatibleModeTextOnlyQwen(model);
		const hasImages = toolMsg.content.some(c => c.type === "image");
		const omittedImages = hasImages && !supportsImages;
		const hasText = textResult.length > 0;
		const remappedToolCallId = idTracker.consumeToolCallId(toolMsg.toolCallId);
		const resolvedToolCallId =
			remappedToolCallId ?? idTracker.ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
		const toolResultContent = omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: hasText
				? textResult
				: hasImages
					? "(see attached image)"
					: "";
		const toolResultMsg: OpenAICompletionsToolMessageParam = {
			role: "tool",
			content: toolResultContent.toWellFormed(),
			tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
		};
		if (compat.requiresToolResultName && toolMsg.toolName) {
			toolResultMsg.name = toolMsg.toolName;
		}
		params.push(toolResultMsg);

		if (hasImages && supportsImages) {
			for (const block of toolMsg.content) {
				if (block.type === "image") {
					imageBlocks.push({
						type: "image_url",
						image_url: {
							url: `data:${block.mimeType};base64,${block.data}`,
						},
					});
				}
			}
		}
	}

	let lastRole = "toolResult";
	if (imageBlocks.length > 0) {
		if (compat.requiresAssistantAfterToolResult) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}
		params.push({
			role: "user",
			content: [
				{
					type: "text",
					text: "Attached image(s) from tool result:",
				},
				...imageBlocks,
			],
		});
		lastRole = "user";
	}
	return { params, nextIndex: j - 1, lastRole };
}

function createOpenAIToolCallIdTracker(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): {
	normalizeToolCallId: (id: string) => string;
	idTracker: {
		rememberToolCallId: (originalId: string, normalizedId: string) => void;
		consumeToolCallId: (originalId: string) => string | null;
		ensureToolCallId: (rawId: string, seed: string) => string;
	};
} {
	const normalizeToolCallId = (id: string): string => {
		if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);
		if (id.includes("|")) {
			const [callId] = id.split("|");
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}
		if (compat.usesOpenAIToolCallIdLimit) return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const idTracker = {
		rememberToolCallId: (originalId: string, normalizedId: string): void => {
			const queue = remappedToolCallIds.get(originalId);
			if (queue) {
				queue.push(normalizedId);
				return;
			}
			remappedToolCallIds.set(originalId, [normalizedId]);
		},
		consumeToolCallId: (originalId: string): string | null => {
			const queue = remappedToolCallIds.get(originalId);
			if (!queue || queue.length === 0) return null;
			const nextId = queue.shift() ?? null;
			if (queue.length === 0) remappedToolCallIds.delete(originalId);
			return nextId;
		},
		ensureToolCallId: (rawId: string, seed: string): string => {
			const normalized = normalizeToolCallId(rawId);
			if (normalized.trim().length > 0) return normalized;
			return generateFallbackToolCallId(seed);
		},
	};

	return { normalizeToolCallId, idTracker };
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const maxNormalizedToolCallIdLength = compat.requiresMistralToolIds
		? 9
		: compat.usesOpenAIToolCallIdLimit
			? 40
			: undefined;
	const duplicateToolCallIdSuffixPrefix = compat.requiresMistralToolIds ? "dup" : undefined;
	const { normalizeToolCallId, idTracker } = createOpenAIToolCallIdTracker(model, compat);
	const transformedMessages = transformMessages(
		context.messages,
		model,
		id => normalizeToolCallId(id),
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
		compat,
	);

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		if (compat.supportsMultipleSystemMessages) {
			for (const systemPrompt of systemPrompts) {
				params.push({ role, content: systemPrompt });
			}
		} else {
			params.push({ role, content: systemPrompts.join("\n\n") });
		}
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			(msg.role === "user" || msg.role === "developer")
		) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "user" || msg.role === "developer") {
			const converted = convertUserOrDeveloperMessage(msg, model, compat);
			params.push(...converted);
		} else if (msg.role === "assistant") {
			const converted = convertAssistantMessage(msg, model, compat, i, idTracker);
			if (converted) params.push(converted);
		} else if (msg.role === "toolResult") {
			const {
				params: toolParams,
				nextIndex,
				lastRole: newLastRole,
			} = convertToolResultBatch(transformedMessages, i, model, compat, idTracker);
			params.push(...toolParams);
			i = nextIndex;
			lastRole = newLastRole;
			continue;
		}

		lastRole =
			msg.role === "developer"
				? model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system"
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
): BuiltOpenAICompletionTools {
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = toolWireSchema(tool);
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const toolStrictMode =
		requestedStrictMode === "none"
			? "none"
			: requestedStrictMode === "all_strict"
				? adaptedTools.every(tool => tool.strict)
					? "all_strict"
					: "none"
				: "mixed";

	return {
		tools: adaptedTools.map(({ tool, baseParameters, parameters, strict }) => {
			const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
			// `strict: false` is semantically distinct from omitted `strict` on some
			// backends: with it absent, optional properties may be over-filled with
			// placeholder values (#4336). Preserve the author's explicit `false`,
			// but only in "mixed" mode against a provider that understands the
			// field — the `all_strict → none` collapse and `supportsStrictMode:
			// false` paths deliberately keep the wire flag uniformly absent.
			const includeExplicitFalse =
				!includeStrict &&
				tool.strict === false &&
				toolStrictMode === "mixed" &&
				compat.supportsStrictMode !== false;
			const wireParameters = includeStrict ? parameters : baseParameters;
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					// Moonshot/Kimi native hosts validate against the stricter MFJS subset
					// (const→enum, typed enums, no validators) and 400 otherwise.
					parameters:
						compat.toolSchemaFlavor === "moonshot-mfjs"
							? (normalizeSchemaForMoonshot(wireParameters) as Record<string, unknown>)
							: wireParameters,
					// Only include strict if provider supports it. Some reject unknown fields.
					...(includeStrict ? { strict: true } : includeExplicitFalse ? { strict: false } : {}),
				},
			};
		}),
		toolStrictMode,
		strictToolsApplied:
			tools.length > 0 &&
			(toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && adaptedTools.some(tool => tool.strict))),
	};
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("content_filter") };
		case "network_error":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("network_error") };
		default:
			// Gateways (OpenRouter, Vercel AI Gateway, …) report upstream model
			// failures as a bare `finish_reason: "error"` with no detail, which the
			// turn domain retries. Every other unrecognised reason states itself.
			return {
				stopReason: "error",
				errorMessage: AIError.providerFinishErrorMessage(typeof reason === "string" ? reason : undefined),
			};
	}
}
