/**
 * One streamed Chat Completions turn, assembled from its chunks.
 *
 * `OpenAICompletionsTurn` applies each `ChatCompletionChunk` to the turn's `AssistantMessage`: it
 * opens, grows and closes the text, thinking and tool-call blocks and pushes their start, delta and
 * end events, runs leaked-markup healing and DeepSeek template-token stripping over visible text,
 * records usage and the finish reason, and reports when the turn has both its terminal signal and
 * its accounting. The request, its retries, the idle watchdog and the final stop-reason rules are in
 * `openai-completions.ts`.
 */
import { tryParseJson } from "@veyyon/utils/json";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import { isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../error";
import type { AssistantMessage, StopReason, TextContent, ThinkingContent, ToolCall } from "../types";
import { clearStreamingPartialJson, kStreamingLastParseLen, setStreamingPartialJson } from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import type { ChatCompletionChunk } from "./openai-chat-wire";
import type { OpenAICompatPolicy } from "./openai-shared";

/** The usage fields an OpenAI-compatible host may send, each read only when it holds a number. */
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

type ProviderAttributedChatCompletionChunk = ChatCompletionChunk & {
	provider?: unknown;
};

type OpenAICompletionsChoiceUsage = ChatCompletionChunk.Choice & {
	usage?: unknown;
};

type OpenAIChunkDelta = ChatCompletionChunk.Choice["delta"];
type OpenAIChunkToolCall = NonNullable<OpenAIChunkDelta["tool_calls"]>[number];

type OpenAICompletionsDeltaWithReasoningDetails = OpenAIChunkDelta & {
	reasoning_details?: unknown;
};

type ToolCallStreamBlock = ToolCall & {
	partialArgs?: string | Record<string, unknown>;
	streamIndex?: number;
	[kStreamingLastParseLen]?: number;
};
type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;

/**
 * The text of one `delta.content` part. Most providers stream `delta.content` as a string, but some
 * (notably Mistral Medium 3.5 / `mistral-medium-2604`) return typed content parts such as
 * `[{ type: "text", text: "Hello" }]`; string-coercing those printed `[object Object]` (issue #911).
 * Non-text parts and unknown shapes read as empty text.
 */
function contentPartText(part: unknown): string {
	if (typeof part === "string") return part;
	if (!part || typeof part !== "object") return "";
	const { type, text } = part as { type?: unknown; text?: unknown };
	return (type === undefined || type === "text") && typeof text === "string" ? text : "";
}

/** `delta.content` as plain text, whether a string, one content part or an array of them. */
function normalizeStreamingContentText(content: unknown): string {
	if (!Array.isArray(content)) return contentPartText(content);
	let out = "";
	for (const part of content) out += contentPartText(part);
	return out;
}

/** An own key of a streamed argument object that may be copied without touching a prototype. */
function isArgumentKey(object: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(object, key) && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function cloneStreamingArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneStreamingArgumentValue);
	if (isRecord(value)) return mergeStreamingArgumentObjects(undefined, value);
	return value;
}

function streamingArgumentObjectsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	let leftKeys = 0;
	for (const key in left) {
		if (!isArgumentKey(left, key)) continue;
		leftKeys++;
		if (!Object.hasOwn(right, key) || !streamingArgumentValuesEqual(left[key], right[key])) return false;
	}
	let rightKeys = 0;
	for (const key in right) {
		if (isArgumentKey(right, key)) rightKeys++;
	}
	return leftKeys === rightKeys;
}

function streamingArgumentValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && streamingArgumentArrayStartsWith(left, right);
	}
	if (isRecord(left) && isRecord(right)) return streamingArgumentObjectsEqual(left, right);
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
	if (streamingArgumentArrayStartsWith(fragment, prev)) return fragment.map(cloneStreamingArgumentValue);
	if (streamingArgumentArrayStartsWith(prev, fragment)) return prev.map(cloneStreamingArgumentValue);
	const merged = prev.map(cloneStreamingArgumentValue);
	for (const value of fragment) merged.push(cloneStreamingArgumentValue(value));
	return merged;
}

function mergeStreamingArgumentValues(prev: unknown, fragment: unknown): unknown {
	if (typeof prev === "string" && typeof fragment === "string") {
		return fragment.startsWith(prev) ? fragment : prev + fragment;
	}
	if (Array.isArray(prev) && Array.isArray(fragment)) return mergeStreamingArgumentArrays(prev, fragment);
	if (isRecord(prev) && isRecord(fragment)) return mergeStreamingArgumentObjects(prev, fragment);
	return cloneStreamingArgumentValue(fragment);
}

/**
 * Object-shaped `function.arguments` (MiniMax-compatible hosts) merged into what earlier chunks
 * sent: a string that restates its prefix replaces it, an array that extends another replaces it,
 * and nested objects merge key by key.
 */
function mergeStreamingArgumentObjects(
	prev: Record<string, unknown> | undefined,
	fragment: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (prev) {
		for (const key in prev) {
			if (isArgumentKey(prev, key)) merged[key] = cloneStreamingArgumentValue(prev[key]);
		}
	}
	for (const key in fragment) {
		if (!isArgumentKey(fragment, key)) continue;
		merged[key] = Object.hasOwn(merged, key)
			? mergeStreamingArgumentValues(merged[key], fragment[key])
			: cloneStreamingArgumentValue(fragment[key]);
	}
	return merged;
}

// DeepSeek models leak chat-template special tokens (e.g. `<｜tool_calls_begin｜>`,
// `<｜DSML｜tool_calls｜>`) into visible `content` deltas when hosted behind providers
// (such as NVIDIA NIM) that don't strip them server-side. The structured `tool_calls`
// payload is still emitted correctly — only the leaked markers are filtered from
// user-visible text. Tokens use either fullwidth pipes (｜, U+FF5C) or ASCII pipes.
// Body is restricted to identifier-like chars (with the DeepSeek tokenizer's `▁`),
// capped at a sane length to avoid swallowing legitimate angle-bracket text.
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

// Find a trailing partial `<｜...` (or `<|...`) that has not yet been closed by a
// matching `｜>`/`|>`, so it can be held back until the next chunk arrives. A solo
// trailing `<` is also held in case it is the start of a new token.
function getTrailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) {
		return text.endsWith("<") ? "<" : "";
	}
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";
	// Cap the held-back length so a stray `<｜` in normal prose can't grow unboundedly.
	if (tail.length > 256) return "";
	return tail;
}

/** Hosts send reasoning under one of these aliases; the first non-empty one is the chunk's reasoning. */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

function extractOpenAIReasoningDelta(deltaRecord: Record<string, unknown>): { field?: string; delta: string } {
	for (const field of REASONING_FIELDS) {
		const reasoningDelta = deltaRecord[field];
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			return { field, delta: reasoningDelta };
		}
	}
	return { delta: "" };
}

function applyOpenAIReasoningDetails(delta: OpenAIChunkDelta, output: AssistantMessage): void {
	if (!("reasoning_details" in delta)) return;
	const details = (delta as OpenAICompletionsDeltaWithReasoningDetails).reasoning_details;
	if (!Array.isArray(details)) return;
	for (const detail of details) {
		if (!isRecord(detail)) continue;
		if (detail.type === "reasoning.encrypted" && typeof detail.id === "string" && detail.data) {
			const matchingToolCall = output.content.find(b => b.type === "toolCall" && b.id === detail.id);
			if (matchingToolCall && matchingToolCall.type === "toolCall") {
				matchingToolCall.thoughtSignature = JSON.stringify(detail);
			}
		}
	}
}

function recordOpenAIChunkMetadata(chunk: ChatCompletionChunk, output: AssistantMessage): void {
	// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
	// and each chunk in a streamed completion carries the same id.
	output.responseId ||= chunk.id;
	if (!output.upstreamProvider) {
		const upstreamProvider = (chunk as ProviderAttributedChatCompletionChunk).provider;
		output.upstreamProvider =
			typeof upstreamProvider === "string" && upstreamProvider.length > 0 ? upstreamProvider : undefined;
	}
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

/** A streamed call with an id, a name and arguments that parse to a JSON object. */
function isCompleteToolCall(block: ToolCallStreamBlock): boolean {
	if (!block.id || !block.name) return false;
	const argumentsValue =
		block.partialArgs === undefined
			? block.arguments
			: typeof block.partialArgs === "string"
				? tryParseJson(block.partialArgs)
				: block.partialArgs;
	return isRecord(argumentsValue);
}

export class OpenAICompletionsTurn {
	/**
	 * `Date.now()` when a chunk carried `finish_reason`, or when a choiceless usage chunk closed a
	 * complete tool-call batch; `undefined` while the turn has no terminal signal.
	 */
	finishedAt: number | undefined;
	/** `performance.now()` at the turn's first visible text or reasoning byte. */
	firstTokenTime: number | undefined;
	readonly #output: AssistantMessage;
	readonly #stream: AssistantMessageEventStream;
	readonly #usageFor: (rawUsage: object) => AssistantMessage["usage"];
	readonly #stripDeepseekTokens: boolean;
	readonly #healing: StreamMarkupHealing | undefined;
	readonly #reasoningMayBeCumulative: boolean;
	#current: OpenAIStreamBlock | undefined;
	readonly #pendingToolCalls: ToolCallStreamBlock[] = [];
	readonly #toolCallByIndex = new Map<number, ToolCallStreamBlock>();
	/**
	 * Blocks born from an unkeyed multi-entry `tool_calls` array (no `id`, no `index`), by array
	 * offset, so continuation chunks that omit the entry name still route back to the sibling created
	 * earlier instead of collapsing onto the current block.
	 */
	readonly #unkeyedBatch: (ToolCallStreamBlock | undefined)[] = [];
	/**
	 * The last full cumulative reasoning snapshot per reasoning field. MiniMax-M3 keeps sending the
	 * same cumulative `reasoning_content` after `</think>` and visible text arrive, when the current
	 * block is already text; keyed outside the block, the snapshot is not re-emitted as a fresh
	 * thinking block after the answer started.
	 */
	readonly #reasoningSnapshots = new Map<string, string>();
	#deepseekHeld = "";
	/** Set once the host streams native reasoning, after which healed thinking is dropped. */
	#suppressHealedThinking = false;
	#sawUsage = false;
	/**
	 * True while the last usage payload had no cache-read count. Some OpenAI-compatible servers send
	 * basic usage with `finish_reason` and cache-read details in a trailing usage-only chunk, so only
	 * a choiceless chunk may end the turn while those details are pending.
	 */
	#awaitTrailingUsageDetails = false;

	constructor(
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
		policy: OpenAICompatPolicy["stream"],
		usageFor: (rawUsage: object) => AssistantMessage["usage"],
	) {
		this.#output = output;
		this.#stream = stream;
		this.#usageFor = usageFor;
		this.#stripDeepseekTokens = policy.stripSpecialTokens === "deepseek";
		this.#healing = policy.markupHealingPattern
			? new StreamMarkupHealing({ pattern: policy.markupHealingPattern })
			: undefined;
		this.#reasoningMayBeCumulative = policy.reasoningDeltasMayBeCumulative;
	}

	/** Applies one chunk; true once the turn has its terminal signal and the accounting to close on. */
	applyChunk(chunk: ChatCompletionChunk | null | undefined): boolean {
		if (!chunk || typeof chunk !== "object") return false;
		recordOpenAIChunkMetadata(chunk, this.#output);
		if (chunk.usage) this.#applyUsage(chunk.usage);

		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
		if (!choice) return this.#endsOnChoicelessChunk();

		if (!chunk.usage) {
			const choiceUsage = (choice as OpenAICompletionsChoiceUsage).usage;
			if (typeof choiceUsage === "object" && choiceUsage !== null) this.#applyUsage(choiceUsage);
		}
		if (choice.finish_reason) this.#applyFinishReason(choice.finish_reason);
		if (choice.delta) this.#applyDelta(choice.delta);

		// Usage that arrived on the finish chunk without cache-read fields keeps the turn draining
		// through the grace window for vLLM-style trailing usage details.
		return this.finishedAt !== undefined && this.#sawUsage && !this.#awaitTrailingUsageDetails;
	}

	/** True when the turn streamed at least one tool call and every one has an id, a name and object arguments. */
	hasCompleteToolCallBatch(): boolean {
		let sawToolCall = false;
		for (const block of this.#output.content) {
			if (block.type !== "toolCall") continue;
			sawToolCall = true;
			if (!isCompleteToolCall(block)) return false;
		}
		return sawToolCall;
	}

	/** Releases the bytes the healer and the DeepSeek filter hold back, then closes every open block. */
	flush(): void {
		const healing = this.#healing;
		if (healing) {
			for (const event of healing.flushEvents()) this.#emitHealingEvent(event);
			for (const call of healing.drainCompleted()) this.#emitHealedToolCall(call);
		}
		this.#releaseDeepseekHeld(true);
		this.closeOpenBlocks();
	}

	/** Closes the open text or thinking block, then every tool call still taking arguments. */
	closeOpenBlocks(): void {
		this.#closeTextOrThinking();
		for (const block of this.#pendingToolCalls.slice()) this.#finishToolCall(block);
	}

	#applyUsage(rawUsage: object): void {
		this.#output.usage = this.#usageFor(rawUsage);
		this.#sawUsage = true;
		this.#awaitTrailingUsageDetails = !hasPositiveCacheReadTokenField(rawUsage);
	}

	/**
	 * A trailing usage-only chunk arrives after generation. A few OpenAI-compatible gateways omit
	 * both `finish_reason` and `[DONE]` after a tool batch but still send it, so it ends the turn as
	 * `toolUse` when every streamed call has an id, a name and complete JSON-object arguments. Text
	 * and partial-call EOFs stay errors. On the compliant path it follows an explicit finish reason.
	 */
	#endsOnChoicelessChunk(): boolean {
		if (this.#sawUsage && this.hasCompleteToolCallBatch()) {
			this.#output.stopReason = "toolUse";
			this.finishedAt ??= Date.now();
			return true;
		}
		return this.finishedAt !== undefined && this.#sawUsage;
	}

	#applyFinishReason(reason: ChatCompletionChunk.Choice["finish_reason"]): void {
		const mapped = mapStopReason(reason);
		this.#output.stopReason = mapped.stopReason;
		if (mapped.errorMessage) this.#output.errorMessage = mapped.errorMessage;
		this.finishedAt ??= Date.now();
	}

	#applyDelta(delta: OpenAIChunkDelta): void {
		this.#applyReasoning(delta);
		this.#applyContent(delta);
		if (delta.tool_calls && delta.tool_calls.length > 0) this.#applyToolCalls(delta.tool_calls);
		applyOpenAIReasoningDetails(delta, this.#output);
	}

	/**
	 * llama.cpp sends reasoning in `reasoning_content`, other hosts in `reasoning`; the first
	 * non-empty alias is used so a chunk carrying several aliases of one text is not duplicated.
	 */
	#applyReasoning(delta: OpenAIChunkDelta): void {
		const { field, delta: reasoning } = extractOpenAIReasoningDelta(delta as Record<string, unknown>);
		if (!field) return;
		this.#appendThinking(reasoning, field, this.#reasoningMayBeCumulative);
		this.#suppressHealedThinking = true;
	}

	#applyContent(delta: OpenAIChunkDelta): void {
		const text = normalizeStreamingContentText(delta.content);
		if (text.length === 0) return;
		this.firstTokenTime ||= performance.now();
		const healing = this.#healing;
		if (!healing) {
			this.#appendVisibleText(text);
			return;
		}
		const events =
			Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
				? healing.feedEventsWithoutCalls(text)
				: healing.feedEvents(text);
		for (const event of events) this.#emitHealingEvent(event);
	}

	#emitHealingEvent(event: StreamMarkupHealingEvent): void {
		if (event.type === "text") this.#appendVisibleText(event.text);
		else if (event.type === "thinking") {
			if (!this.#suppressHealedThinking) this.#appendThinking(event.thinking, undefined, false);
		} else this.#emitHealedToolCall(event.call);
	}

	/** Visible text after healing: through the DeepSeek token filter when the model leaks its template. */
	#appendVisibleText(text: string): void {
		if (text.length === 0) return;
		if (!this.#stripDeepseekTokens) {
			this.#appendText(text);
			return;
		}
		this.#deepseekHeld += text;
		this.#releaseDeepseekHeld(false);
	}

	/** Emits held DeepSeek text without its special tokens, keeping back a token not yet closed unless `final`. */
	#releaseDeepseekHeld(final: boolean): void {
		const held = this.#deepseekHeld;
		if (held.length === 0) return;
		const trailing = final ? "" : getTrailingPartialDeepseekToken(held);
		const flushable = held.slice(0, held.length - trailing.length);
		this.#deepseekHeld = trailing;
		const stripped = stripDeepseekSpecialTokens(flushable);
		if (stripped && (stripped === flushable || stripped.trim().length > 0)) this.#appendText(stripped);
	}

	#appendText(text: string): void {
		if (!text) return;
		this.firstTokenTime ||= performance.now();
		let block = this.#current;
		if (block?.type !== "text") {
			this.#closeTextOrThinking();
			block = { type: "text", text: "" };
			this.#current = block;
			this.#output.content.push(block);
			this.#stream.push({ type: "text_start", contentIndex: this.#blockIndex(block), partial: this.#output });
		}
		block.text += text;
		this.#stream.push({
			type: "text_delta",
			contentIndex: this.#blockIndex(block),
			delta: text,
			partial: this.#output,
		});
	}

	/**
	 * Appends reasoning to the current thinking block, opening one when none is current or the
	 * reasoning field changed. A `cumulative` host resends the whole reasoning so far, so only the
	 * growth past the last snapshot of that field is appended.
	 */
	#appendThinking(thinking: string, signature: string | undefined, cumulative: boolean): void {
		if (!thinking) return;
		const delta = cumulative ? this.#reasoningGrowth(thinking, signature ?? "") : thinking;
		if (!delta) return;
		this.firstTokenTime ||= performance.now();
		let block = this.#current;
		if (block?.type !== "thinking" || (signature !== undefined && block.thinkingSignature !== signature)) {
			this.#closeTextOrThinking();
			block = { type: "thinking", thinking: "", thinkingSignature: signature };
			this.#current = block;
			this.#output.content.push(block);
			this.#stream.push({ type: "thinking_start", contentIndex: this.#blockIndex(block), partial: this.#output });
		}
		block.thinking += delta;
		this.#stream.push({
			type: "thinking_delta",
			contentIndex: this.#blockIndex(block),
			delta,
			partial: this.#output,
		});
	}

	#reasoningGrowth(snapshot: string, field: string): string {
		const last = this.#reasoningSnapshots.get(field) ?? "";
		this.#reasoningSnapshots.set(field, snapshot);
		return snapshot.startsWith(last) ? snapshot.slice(last.length) : snapshot;
	}

	#emitHealedToolCall(call: HealedToolCall): void {
		this.#finishBlock(this.#current);
		const block: ToolCall & { partialArgs: string } = {
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: {},
			partialArgs: call.arguments,
		};
		block.arguments = parseStreamingJson(call.arguments);
		this.#current = block;
		this.#output.content.push(block);
		const contentIndex = this.#blockIndex(block);
		this.#stream.push({ type: "toolcall_start", contentIndex, partial: this.#output });
		this.#stream.push({ type: "toolcall_delta", contentIndex, delta: call.arguments, partial: this.#output });
		this.#finishBlock(block);
		this.#current = undefined;
	}

	#applyToolCalls(toolCalls: OpenAIChunkToolCall[]): void {
		for (let offset = 0; offset < toolCalls.length; offset++) {
			const toolCall = toolCalls[offset]!;
			const block = this.#toolCallBlock(toolCall, offset, toolCalls.length);
			if (toolCall.id) block.id = toolCall.id;
			const name = toolCall.function?.name;
			if (name) block.name = name;
			const delta = this.#appendToolCallArguments(block, toolCall.function?.arguments);
			this.#stream.push({
				type: "toolcall_delta",
				contentIndex: this.#blockIndex(block),
				delta,
				partial: this.#output,
			});
		}
	}

	/** The block a `tool_calls` entry continues, made current; a new block when it continues none. */
	#toolCallBlock(toolCall: OpenAIChunkToolCall, offset: number, batchSize: number): ToolCallStreamBlock {
		const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
		const unkeyed = batchSize > 1 && streamIndex === undefined && !toolCall.id;
		const existing = this.#continuedToolCall(toolCall, streamIndex, unkeyed ? offset : undefined);
		// A text or thinking block ends here. Tool-call blocks stay pending: chunks after the first
		// typically carry only `index`, so a finished call would be reborn as a nameless phantom.
		this.#closeTextOrThinking();
		if (!existing) {
			return this.#openToolCall(
				toolCall.id || "",
				toolCall.function?.name || "",
				streamIndex,
				unkeyed ? offset : undefined,
			);
		}
		this.#current = existing;
		if (streamIndex !== undefined && existing.streamIndex === undefined) {
			existing.streamIndex = streamIndex;
			this.#toolCallByIndex.set(streamIndex, existing);
		}
		return existing;
	}

	/**
	 * The block an entry continues: by stream `index`, by `id`, by offset within an unkeyed batch,
	 * or the current tool call when the entry names no other id.
	 */
	#continuedToolCall(
		toolCall: OpenAIChunkToolCall,
		streamIndex: number | undefined,
		batchOffset: number | undefined,
	): ToolCallStreamBlock | undefined {
		const byIndex = streamIndex === undefined ? undefined : this.#toolCallByIndex.get(streamIndex);
		if (byIndex) return byIndex;
		const id = toolCall.id;
		const byId = id ? this.#pendingToolCalls.find(candidate => candidate.id === id) : undefined;
		if (byId) return byId;
		if (batchOffset !== undefined) {
			const sibling = this.#unkeyedBatch[batchOffset];
			return sibling?.partialArgs !== undefined ? sibling : undefined;
		}
		const current = this.#current;
		return current?.type === "toolCall" && (!id || current.id === id) ? current : undefined;
	}

	#openToolCall(
		id: string,
		name: string,
		streamIndex: number | undefined,
		batchOffset: number | undefined,
	): ToolCallStreamBlock {
		const block: ToolCallStreamBlock = { type: "toolCall", id, name, arguments: {}, partialArgs: "", streamIndex };
		if (streamIndex !== undefined) this.#toolCallByIndex.set(streamIndex, block);
		this.#pendingToolCalls.push(block);
		this.#current = block;
		this.#output.content.push(block);
		this.#stream.push({ type: "toolcall_start", contentIndex: this.#blockIndex(block), partial: this.#output });
		if (batchOffset !== undefined) this.#unkeyedBatch[batchOffset] = block;
		return block;
	}

	/** Folds one entry's arguments into the block; returns the wire delta, empty for object-shaped arguments. */
	#appendToolCallArguments(block: ToolCallStreamBlock, rawArgs: unknown): string {
		if (typeof rawArgs === "string") {
			if (rawArgs.length === 0) return "";
			const partialArgs = (typeof block.partialArgs === "string" ? block.partialArgs : "") + rawArgs;
			block.partialArgs = partialArgs;
			setStreamingPartialJson(block, partialArgs);
			const throttled = parseStreamingJsonThrottled(partialArgs, block[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				block.arguments = throttled.value;
				block[kStreamingLastParseLen] = throttled.parsedLen;
			}
			return rawArgs;
		}
		if (isRecord(rawArgs)) {
			const merged = mergeStreamingArgumentObjects(
				isRecord(block.partialArgs) ? block.partialArgs : undefined,
				rawArgs,
			);
			block.partialArgs = merged;
			block.arguments = merged;
		}
		return "";
	}

	#closeTextOrThinking(): void {
		if (this.#current?.type !== "toolCall") this.#finishBlock(this.#current);
	}

	#finishBlock(block: OpenAIStreamBlock | undefined): void {
		if (!block) return;
		const contentIndex = this.#blockIndex(block);
		if (contentIndex < 0) return;
		if (block.type === "text") {
			this.#stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.#output });
		} else if (block.type === "thinking") {
			this.#stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.#output });
		} else {
			this.#finishToolCall(block);
		}
	}

	#finishToolCall(block: ToolCallStreamBlock): void {
		const partialArgs = block.partialArgs;
		if (partialArgs === undefined) return;
		const contentIndex = this.#blockIndex(block);
		if (contentIndex < 0) return;
		if (typeof partialArgs === "string") {
			block.arguments = parseStreamingJson(partialArgs);
		} else {
			this.#flushObjectArguments(partialArgs, contentIndex);
			block.arguments = partialArgs;
		}
		delete block.partialArgs;
		// The published mirror goes with the accumulator: a marker left holding text is how
		// `agent-loop.ts` tells a call whose arguments never finished from one that closed normally.
		clearStreamingPartialJson(block);
		if (block.streamIndex !== undefined) {
			this.#toolCallByIndex.delete(block.streamIndex);
			delete block.streamIndex;
		}
		const pendingIndex = this.#pendingToolCalls.indexOf(block);
		if (pendingIndex >= 0) this.#pendingToolCalls.splice(pendingIndex, 1);
		for (let offset = 0; offset < this.#unkeyedBatch.length; offset++) {
			if (this.#unkeyedBatch[offset] === block) this.#unkeyedBatch[offset] = undefined;
		}
		this.#stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.#output });
	}

	/**
	 * Object-shaped arguments are held with an empty wire delta per chunk, because each chunk's
	 * `JSON.stringify` would feed concat-based consumers (proxy.ts, openai-chat-server,
	 * openai-responses-server, anthropic-messages-server) an invalid `{"input":"a"}{"input":"b"}`.
	 * The merged object goes out as one concat-safe delta before `toolcall_end`.
	 */
	#flushObjectArguments(merged: Record<string, unknown>, contentIndex: number): void {
		const fullJson = JSON.stringify(merged);
		if (fullJson.length > 0 && fullJson !== "{}") {
			this.#stream.push({ type: "toolcall_delta", contentIndex, delta: fullJson, partial: this.#output });
		}
	}

	#blockIndex(block: OpenAIStreamBlock): number {
		return this.#output.content.indexOf(block);
	}
}
