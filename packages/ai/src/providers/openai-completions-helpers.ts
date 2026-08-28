import type { Effort } from "@veyyon/catalog/effort";
import { resolveReasoningSelection } from "@veyyon/catalog/model-thinking";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import type {
	Message,
	Model,
	ProviderSessionState,
	ServiceTier,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolChoice,
} from "../types";
import { kStreamingLastParseLen } from "../utils/block-symbols";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
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

export function firstPositiveNumber(...values: unknown[]): number {
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

export function normalizeMistralToolId(id: string, isMistral: boolean): string {
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

export function cloneStreamingArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneStreamingArgumentValue);
	}
	if (isRecord(value)) {
		return mergeStreamingArgumentObjects(undefined, value as Record<string, unknown>);
	}
	return value;
}

export function streamingArgumentValuesEqual(left: unknown, right: unknown): boolean {
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

export function streamingArgumentArrayStartsWith(value: unknown[], prefix: unknown[]): boolean {
	if (prefix.length > value.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!streamingArgumentValuesEqual(value[i], prefix[i])) return false;
	}
	return true;
}

export function mergeStreamingArgumentArrays(prev: unknown[], fragment: unknown[]): unknown[] {
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

export function mergeStreamingArgumentValues(prev: unknown, fragment: unknown): unknown {
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

export function openAICompletionsProviderSessionStateKey(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
): string {
	return `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${model.id}:${baseUrl ?? ""}`;
}

export type OpenAICompletionsProviderSessionState = ProviderSessionState &
	OpenAIStrictToolsState &
	OpenAIReasoningEffortFallbackState;
export function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
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
