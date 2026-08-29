import type { Effort } from "@veyyon/catalog/effort";
import { resolveReasoningSelection } from "@veyyon/catalog/model-thinking";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Message,
	Model,
	ProviderSessionState,
	ServiceTier,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { isDemotedThinking, kStreamingLastParseLen } from "../utils/block-symbols";
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
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackState,
	type OpenAIReasoningEffortFallbackState,
} from "./openai-reasoning-fallback";
import {
	applyWireModelIdTransform,
	calculateOpenAIUsageAccounting,
	clearOpenAIStrictToolsState,
	createOpenAIStrictToolsState,
	type OpenAIStrictToolsState,
} from "./openai-shared";

export { applyOpenRouterRoutingVariant } from "./openai-shared";

export type OpenAICompletionsReasoningField = NonNullable<ResolvedOpenAICompat["reasoningContentField"]>;

export type ProviderAttributedChatCompletionChunk = ChatCompletionChunk & {
	provider?: unknown;
};

export type OpenAICompletionsChoiceUsage = ChatCompletionChunk.Choice & {
	usage?: unknown;
};

export type OpenAICompletionsDeltaWithReasoningDetails = ChatCompletionChunk.Choice["delta"] & {
	reasoning_details?: unknown;
};

export type OpenAICompletionsAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: unknown[];
	};

export type OpenAICompletionsToolMessageParam = ChatCompletionToolMessageParam & {
	name?: string;
};

export type OpenAICompletionsUsageLike = {
	completion_tokens?: unknown;
	prompt_tokens?: unknown;
	cached_tokens?: unknown;
	prompt_cache_hit_tokens?: unknown;
	prompt_cache_miss_tokens?: unknown;
	prompt_tokens_details?: unknown;
	completion_tokens_details?: unknown;
};

export type OpenAICompletionsPromptTokenDetails = {
	cached_tokens?: unknown;
	cache_write_tokens?: unknown;
};

export type OpenAICompletionsCompletionTokenDetails = {
	reasoning_tokens?: unknown;
};

function firstPositiveNumber(...values: unknown[]): number {
	for (const value of values) {
		if (typeof value === "number" && value > 0) return value;
	}
	return 0;
}

export function hasPositiveCacheReadTokenField(rawUsage: object): boolean {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	if (typeof usageLike.cached_tokens === "number" && usageLike.cached_tokens > 0) return true;
	if (typeof usageLike.prompt_cache_hit_tokens === "number" && usageLike.prompt_cache_hit_tokens > 0) return true;

	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	if (typeof rawPromptTokenDetails !== "object" || rawPromptTokenDetails === null) return false;

	const promptTokenDetails = rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails;
	return typeof promptTokenDetails.cached_tokens === "number" && promptTokenDetails.cached_tokens > 0;
}

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

export function resolveOpenAICompletionsModelId(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): string {
	const selection = resolveReasoningSelection(model, {
		effort: options?.reasoning as Effort | undefined,
		disabled: options?.disableReasoning,
	});
	const wireId = selection.wireModelId;
	return applyWireModelIdTransform(wireId, model.compat.wireModelIdMode, options?.openrouterVariant);
}

export function normalizeStreamingContentText(content: unknown): string {
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

export function mergeStreamingArgumentObjects(
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

export function hasToolHistory(messages: Message[]): boolean {
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
	disableReasoning?: boolean;
	serviceTier?: ServiceTier;
	maxTokensExplicit?: boolean;
	openrouterVariant?: string;
}

export type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
export type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

export type BuiltOpenAICompletionTools = {
	tools: ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;
	strictToolsApplied: boolean;
};

export const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

function openAICompletionsProviderSessionStateKey(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
): string {
	return `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${model.id}:${baseUrl ?? ""}`;
}

export type OpenAICompletionsProviderSessionState = ProviderSessionState &
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

export function getOpenAICompletionsProviderSessionState(
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

export const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
export const DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
export const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
export const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

export function stripDeepseekSpecialTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
	if (stripped === text) return text;
	let normalized = stripped;
	if (DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
}

export function getTrailingPartialDeepseekToken(text: string): string {
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

export const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";
export const OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS = 2_500;
export type ToolCallStreamBlock = ToolCall & {
	partialArgs?: string | Record<string, unknown>;
	streamIndex?: number;
	[kStreamingLastParseLen]?: number;
};
export type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;

import { calculateCost, emptyCost } from "@veyyon/catalog/models";
import { tryParseJson } from "@veyyon/utils/json";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { normalizeSystemPrompts } from "../utils";
import { adaptSchemaForStrict, NO_STRICT, normalizeSchemaForMoonshot, toolWireSchema } from "../utils/schema";
import type { CacheControlEphemeral } from "./anthropic-wire";
import { transformMessages } from "./transform-messages";
import {
	isDashscopeCompatibleModeTextOnlyQwen,
	joinTextWithImagePlaceholder,
	NON_VISION_IMAGE_PLACEHOLDER,
} from "./vision-guard";

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

export function maybeAddAnthropicCacheControl(
	compat: ResolvedOpenAICompat,
	messages: ChatCompletionMessageParam[],
	cacheRetention: CacheRetention,
): void {
	if (compat.cacheControlFormat !== "anthropic") return;
	if (cacheRetention === "none") return;
	const cacheControl: CacheControlEphemeral =
		cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
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

export function convertTools(
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
					parameters:
						compat.toolSchemaFlavor === "moonshot-mfjs"
							? (normalizeSchemaForMoonshot(wireParameters) as Record<string, unknown>)
							: wireParameters,
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

export function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
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
			return {
				stopReason: "error",
				errorMessage: AIError.providerFinishErrorMessage(typeof reason === "string" ? reason : undefined),
			};
	}
}
