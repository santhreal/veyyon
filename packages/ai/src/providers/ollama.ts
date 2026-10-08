import { normalizeOllamaCloudBaseUrl } from "@veyyon/catalog/provider-models/ollama";
import { parseStreamingJson } from "@veyyon/utils/json-parse";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolChoice,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { clearStreamingPartialJson, kStreamingPartialJson } from "../utils/block-symbols";
import {
	EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE,
	hasVisibleAssistantContent,
	withEmptyCompletionRetry,
} from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type CapturedHttpErrorResponse,
	captureHttpErrorResponse,
	materializeDumpBody,
	type RawHttpRequestDump,
} from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
} from "../utils/idle-iterator";
import { fetchProviderWithRetry } from "../utils/provider-fetch";
import { sanitizeSchemaForOllama, toolWireSchema } from "../utils/schema";
import {
	getStreamMarkupHealingPattern,
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import { createInitialResponsesAssistantMessage } from "./initial-message";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, partitionVisionContent } from "./vision-guard";

export interface OllamaChatOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
}

type OllamaFunctionTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
};

type OllamaMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: string[];
	thinking?: string;
	tool_calls?: Array<{
		type: "function";
		function: {
			index?: number;
			name: string;
			arguments: Record<string, unknown>;
		};
	}>;
	tool_name?: string;
};

type OllamaChunkToolCall = {
	type?: string;
	function?: {
		index?: number;
		name?: string;
		arguments?: Record<string, unknown> | string;
	};
};

type OllamaChatChunk = {
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		tool_calls?: OllamaChunkToolCall[];
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
};

type InternalToolCallBlock = AssistantMessage["content"][number] & {
	type: "toolCall";
	[kStreamingPartialJson]?: string;
};

type OllamaThinkValue = boolean | "low" | "medium" | "high" | "max" | undefined;

function mapReasoning(
	model: Model<"ollama-chat">,
	reasoning: OllamaChatOptions["reasoning"],
	disableReasoning: boolean | undefined,
): OllamaThinkValue {
	const modelReasoning = model.reasoning;
	if (disableReasoning && modelReasoning) {
		return false;
	}
	const mappedReasoning =
		model.provider === "ollama-cloud" && reasoning
			? (model.thinking?.effortMap?.[reasoning] ?? reasoning)
			: reasoning;
	switch (mappedReasoning) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "max":
			return "max";
		case "xhigh":
			return "high";
		default:
			return undefined;
	}
}

function mapToolChoice(toolChoice: ToolChoice | undefined): "auto" | "none" | "required" | undefined {
	if (!toolChoice || toolChoice === "auto") {
		return undefined;
	}
	if (toolChoice === "none") {
		return "none";
	}
	if (toolChoice === "required" || toolChoice === "any") {
		return "required";
	}
	if (typeof toolChoice === "object") {
		return "required";
	}
	return undefined;
}

function getNamedToolChoiceName(toolChoice: ToolChoice | undefined): string | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return undefined;
	}
	if ("function" in toolChoice) {
		return toolChoice.function.name;
	}
	return toolChoice.name;
}

function selectToolsForToolChoice(tools: Tool[] | undefined, toolChoice: ToolChoice | undefined): Tool[] | undefined {
	const toolName = getNamedToolChoiceName(toolChoice);
	if (!toolName || !tools) {
		return tools;
	}
	for (const tool of tools) {
		if (tool.name === toolName) {
			return [tool];
		}
	}
	return [];
}

function toPlainContent(
	content: string | ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	content: string;
	images?: string[];
} {
	if (typeof content === "string") {
		return { content };
	}
	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const text = textBlocks.map(block => block.text).join("\n");
	return {
		content: joinTextWithImagePlaceholder(text, omittedImages),
		...(imageBlocks.length > 0 ? { images: imageBlocks.map(block => block.data) } : {}),
	};
}

function convertMessage(
	message: Message,
	supportsImages: boolean,
	developerRole: "system" | "user" = "user",
): OllamaMessage {
	if (message.role === "user") {
		const converted = toPlainContent(message.content, supportsImages);
		return { role: "user", ...converted };
	}
	if (message.role === "developer") {
		const converted = toPlainContent(message.content, supportsImages);
		return { role: developerRole, ...converted };
	}
	if (message.role === "toolResult") {
		const converted = toPlainContent(message.content, supportsImages);
		return {
			role: "tool",
			tool_name: message.toolName,
			...converted,
		};
	}
	const text: string[] = [];
	const thinking: string[] = [];
	const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
	for (const block of message.content) {
		if (block.type === "text") {
			text.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			thinking.push(block.thinking);
			continue;
		}
		if (block.type === "toolCall") {
			toolCalls.push({
				type: "function",
				function: {
					name: block.name,
					arguments: block.arguments,
				},
			});
		}
	}
	return {
		role: "assistant",
		content: text.join("\n"),
		...(thinking.length > 0 ? { thinking: thinking.join("\n") } : {}),
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	};
}

function convertMessages(model: Model<"ollama-chat">, context: Context): OllamaMessage[] {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const systemMessages: Message[] = systemPrompts.map(systemPrompt => ({
		role: "developer",
		content: systemPrompt,
		timestamp: Date.now(),
	}));
	const messages: Message[] = systemMessages.concat(context.messages);
	const isCloud = model.provider === "ollama-cloud";
	const supportsImages = model.input.includes("image");
	return transformMessages(messages, model).map((msg, index) => {
		// Real `systemPrompt` entries (always emitted first) stay on Ollama's
		// `system` role. After the static prefix, a developer turn keeps `system`
		// when it's an agent-owned control instruction (empty/unexpected-stop
		// retries, checkpoint rewind warning, todo reminders — all carry
		// `attribution: "agent"`), but a user-attributed developer turn (auto-learn
		// capture nudge, advisor cards, file-mention companions) drops to `user`.
		// That keeps the in-conversation byte prefix stable for prefix caches
		// (llama.cpp, #3456) without demoting mandatory agent reminders.
		const developerRole =
			msg.role === "developer" && (index < systemPrompts.length || msg.attribution !== "user") ? "system" : "user";
		const converted = convertMessage(msg, supportsImages, developerRole);
		// Ollama cloud rejects requests when assistant history messages contain the `thinking`
		// field — it's valid in model responses but not accepted as a history input. Strip it
		// to prevent HTTP 400 errors. Local Ollama instances are unaffected.
		if (isCloud && converted.role === "assistant" && converted.thinking) {
			const { thinking: _t, ...rest } = converted;
			return rest;
		}
		return converted;
	});
}

function convertTools(tools: Tool[] | undefined): OllamaFunctionTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map(tool => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: sanitizeSchemaForOllama(toolWireSchema(tool)),
		},
	}));
}

/**
 * Ollama Cloud rejects `num_predict` above this value with HTTP 400
 * (`max_tokens (...) exceeds model's maximum output tokens (65536)`).
 * The cap currently applies uniformly to cloud-served models; the cloud-side
 * limit was confirmed empirically against `deepseek-v4-pro`/`-flash` and is
 * the same cap surfaced for every other Ollama Cloud model we've probed.
 *
 * Acts as a wire-level safety net so stale `models.db` rows (or custom
 * `modelOverrides` re-enabling `num_predict`) cannot 400 the request — even
 * when `model.omitMaxOutputTokens` was never applied. See #3392.
 */
const OLLAMA_CLOUD_NUM_PREDICT_CAP = 65_536;

function resolveNumPredict(model: Model<"ollama-chat">, requested: number): number {
	if (model.provider === "ollama-cloud") {
		return Math.min(requested, OLLAMA_CLOUD_NUM_PREDICT_CAP);
	}
	return requested;
}

function createChatBody(model: Model<"ollama-chat">, context: Context, options: OllamaChatOptions | undefined) {
	const think = mapReasoning(model, options?.reasoning, options?.disableReasoning);
	const toolChoice = mapToolChoice(options?.toolChoice);
	const selectedTools = selectToolsForToolChoice(context.tools, options?.toolChoice);
	const tools = convertTools(selectedTools);
	return {
		model: model.id,
		messages: convertMessages(model, context),
		...(tools ? { tools } : {}),
		...(think !== undefined ? { think } : {}),
		...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
		...(options?.maxTokens !== undefined && !model.omitMaxOutputTokens
			? { options: { num_predict: resolveNumPredict(model, options.maxTokens) } }
			: {}),
		stream: true,
	};
}

/**
 * What a local server states for itself: the llama.cpp tool-call parse failure, which answers 500 and
 * reproduces on every replay because the same prompt produces the same malformed output. The rest of
 * the verdict is `retryResponse`'s.
 */
const OLLAMA_RESPONSE_RETRY_POLICY: AIError.ResponseRetryPolicy = {
	api: "ollama-chat",
	refusesReplay: body => AIError.LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(body),
};

async function* iterateNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChatChunk> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex < 0) {
				break;
			}
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			yield JSON.parse(line) as OllamaChatChunk;
		}
	}
	buffer += decoder.decode();
	const tail = buffer.trim();
	if (tail) {
		yield JSON.parse(tail) as OllamaChatChunk;
	}
}

function endThinkingBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
	}
}

function endTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "text") {
		stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
	}
}

function endToolCallBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type !== "toolCall") {
		return;
	}
	const toolCall = block as InternalToolCallBlock;
	if (toolCall[kStreamingPartialJson]) {
		toolCall.arguments = parseStreamingJson<Record<string, unknown>>(toolCall[kStreamingPartialJson]);
		clearStreamingPartialJson(toolCall);
	}
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
}

function mapDoneReason(doneReason: string | undefined, output: AssistantMessage): AssistantMessage["stopReason"] {
	if (doneReason === "length") {
		return "length";
	}
	if (doneReason === "tool_calls") {
		return "toolUse";
	}
	if (doneReason === undefined && output.content.some(block => block.type === "toolCall")) {
		return "toolUse";
	}
	return "stop";
}

const OLLAMA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/** What a turn's request sent and what an error response said, for the error a failed turn reports. */
interface OllamaRequestRecord {
	dump?: RawHttpRequestDump;
	/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
	bodyJson?: string;
	errorResponse?: CapturedHttpErrorResponse;
}

/** Send the chat request and return the streamed response body, recording what was sent in `request`. */
async function openOllamaResponse(
	model: Model<"ollama-chat">,
	context: Context,
	options: OllamaChatOptions,
	request: OllamaRequestRecord,
): Promise<ReadableStream<Uint8Array>> {
	const apiKey = options.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}
	const baseUrl = normalizeOllamaCloudBaseUrl(model.baseUrl);
	let body = createChatBody(model, context, options);
	const replacementPayload = await options.onPayload?.(body, model);
	if (replacementPayload !== undefined) {
		body = replacementPayload as typeof body;
	}
	request.dump = {
		provider: model.provider,
		api: model.api,
		model: model.id,
		method: "POST",
		url: `${baseUrl}/api/chat`,
	};
	const bodyJson = JSON.stringify(body);
	request.bodyJson = bodyJson;
	// Direct callers that bypass `register-builtins` (which installs
	// the iterator-level watchdog) need a pre-response timer alongside
	// `timeout: false`; otherwise an Ollama server that accepts the
	// POST and never streams headers would hang forever (issue #2422).
	const idleTimeoutMs = options.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
	const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
	// Cleared the instant headers arrive (below) so the pre-response timer
	// never aborts the actively streaming body — an absolute
	// `AbortSignal.timeout` would (issue #2422).
	const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
	let response: Response;
	try {
		response = await fetchProviderWithRetry(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: {
				...model.headers,
				...options.headers,
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: bodyJson,
			signal: watchdog.signal,
			defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
			maxDelayMs: options.maxRetryDelayMs,
			retry: OLLAMA_RESPONSE_RETRY_POLICY,
			fetch: options.fetch,
			timeout: false,
		});
	} finally {
		watchdog.clear();
	}
	if (!response.ok) {
		request.errorResponse = await captureHttpErrorResponse(response);
		throw new AIError.OllamaApiError(`HTTP ${response.status} from ${baseUrl}/api/chat`, response.status, {
			headers: response.headers,
		});
	}
	if (!response.body) {
		throw new AIError.OllamaApiError("Ollama returned an empty response body", response.status, {
			headers: response.headers,
		});
	}
	return response.body;
}

/**
 * One Ollama turn as it streams: the assistant message it builds, the text, thinking and tool-call
 * blocks still open, the markup the text channel leaked, and when the first token arrived.
 */
class OllamaTurn {
	readonly output: AssistantMessage;
	readonly #model: Model<"ollama-chat">;
	readonly #stream: AssistantMessageEventStream;
	readonly #startTime = performance.now();
	#firstTokenTime: number | undefined;
	#sawDone = false;
	#thinkingIndex: number | undefined;
	#textIndex: number | undefined;
	/** Structured tool calls, open until the `done` line closes them. */
	readonly #toolIndices = new Set<number>();
	// `getStreamMarkupHealingPattern` always names a pattern -- "thinking" is the
	// floor, not an absence -- so the healer is always present here. Ollama heals
	// inline rather than through the generic wrap because it alone knows whether
	// the provider also streamed native reasoning (`#suppressHealedThinking`).
	readonly #healing: StreamMarkupHealing;
	// Once the provider streams native reasoning (`message.thinking`), drop any
	// thinking the text-channel healer also recovers so a model that emits both
	// does not double-count its reasoning.
	#suppressHealedThinking = false;

	constructor(model: Model<"ollama-chat">, stream: AssistantMessageEventStream) {
		this.#model = model;
		this.#stream = stream;
		this.output = createInitialResponsesAssistantMessage("ollama-chat" as Api, model.provider, model.id);
		this.#healing = new StreamMarkupHealing({ pattern: getStreamMarkupHealingPattern(model.provider, model.id) });
	}

	/** Fold one NDJSON line of the response into the message and the event stream. */
	consume(chunk: OllamaChatChunk): void {
		const message = chunk.message;
		if (message?.thinking) {
			this.#suppressHealedThinking = true;
			this.#appendThinking(message.thinking);
		}
		const structuredCalls = message?.tool_calls?.length ? message.tool_calls : undefined;
		if (message?.content) {
			const events = structuredCalls
				? this.#healing.feedEventsWithoutCalls(message.content)
				: this.#healing.feedEvents(message.content);
			for (const event of events) this.#emitHealingEvent(event);
		}
		if (structuredCalls) this.#openStructuredCalls(structuredCalls);
		if (chunk.done) this.#close(chunk);
	}

	/** End the turn at the end of the response: report it done, or throw when nothing said it was over. */
	finish(): void {
		this.#flushHealing();
		this.#endThinking();
		this.#endText();
		this.#settleStopReason();
		this.#stampTiming();
		const stopReason = this.output.stopReason;
		if (stopReason === "error") {
			this.#stream.push({ type: "error", reason: "error", error: this.output });
		} else {
			const reason = stopReason === "length" || stopReason === "toolUse" ? stopReason : "stop";
			this.#stream.push({ type: "done", reason, message: this.output });
		}
		this.#stream.end();
	}

	/** Report a failed turn: the error the request and response classify, after what streamed so far. */
	async fail(error: unknown, request: OllamaRequestRecord): Promise<void> {
		for (const block of this.output.content) {
			if (block.type === "toolCall") {
				clearStreamingPartialJson(block);
			}
		}
		const result = await AIError.finalize(error, {
			api: this.#model.api,
			provider: this.#model.provider,
			rawRequestDump: materializeDumpBody(request.dump, request.bodyJson),
			capturedErrorResponse: request.errorResponse,
		});
		AIError.applyFinalizeResult(this.output, result);
		this.#stampTiming();
		this.#stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
		this.#stream.end();
	}

	/** The `done` line: close every open block, and read the stop reason and usage it reports. */
	#close(chunk: OllamaChatChunk): void {
		this.#sawDone = true;
		this.#flushHealing();
		this.#endThinking();
		this.#endText();
		for (const index of this.#toolIndices) {
			endToolCallBlock(this.#stream, this.output, index);
		}
		this.#toolIndices.clear();
		this.output.stopReason = mapDoneReason(chunk.done_reason, this.output);
		this.output.usage.input = chunk.prompt_eval_count ?? 0;
		this.output.usage.output = chunk.eval_count ?? 0;
		this.output.usage.totalTokens = this.output.usage.input + this.output.usage.output;
	}

	/** The stop reason the turn ends on, from what the response said and what it streamed. */
	#settleStopReason(): void {
		const output = this.output;
		// No chunk ever carried `done`, so nothing in the response said the
		// turn was over and `output.stopReason` is still the seed it was given
		// before the first line arrived — an empty body reached the session as
		// a finished answer. A tool call still open at EOF is a partial batch:
		// its arguments never closed.
		if (!this.#sawDone) {
			const stopReason = stopReasonForTerminallessEof(output.content, this.#toolIndices.size === 0);
			if (stopReason === undefined) {
				throw new AIError.ProviderResponseError(
					"Ollama stream ended without a done chunk (connection dropped or response truncated)",
					{ provider: this.#model.provider, kind: "incomplete-stream" },
				);
			}
			output.stopReason = stopReason;
		}
		if (output.stopReason === "length" && !hasVisibleAssistantContent(output)) {
			output.stopReason = "error";
			output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
		}
		// Tool calls always mean "execute and continue" in the OpenAI/Ollama contract,
		// whether the provider sent them structured or the healer recovered them from
		// the text. If the turn produced tool-call blocks but reported a natural `stop`,
		// promote to `toolUse` so the agent loop runs them (it gates execution on the
		// stop reason). `length`/`aborted`/`error` are intentionally left untouched.
		if (output.stopReason === "stop" && output.content.some(block => block.type === "toolCall")) {
			output.stopReason = "toolUse";
		}
	}

	#stampTiming(): void {
		this.output.duration = performance.now() - this.#startTime;
		if (this.#firstTokenTime) {
			this.output.ttft = this.#firstTokenTime - this.#startTime;
		}
	}

	/** Emit what the healer recovered from text the stream already passed it, and every call it completed. */
	#flushHealing(): void {
		for (const event of this.#healing.flushEvents()) this.#emitHealingEvent(event);
		for (const call of this.#healing.drainCompleted()) this.#emitHealedToolCall(call);
	}

	#emitHealingEvent(event: StreamMarkupHealingEvent): void {
		if (event.type === "text") {
			this.#appendText(event.text);
		} else if (event.type === "thinking") {
			if (!this.#suppressHealedThinking) this.#appendThinking(event.thinking);
		} else {
			this.#emitHealedToolCall(event.call);
		}
	}

	#endText(): void {
		if (this.#textIndex === undefined) return;
		endTextBlock(this.#stream, this.output, this.#textIndex);
		this.#textIndex = undefined;
	}

	#endThinking(): void {
		if (this.#thinkingIndex === undefined) return;
		endThinkingBlock(this.#stream, this.output, this.#thinkingIndex);
		this.#thinkingIndex = undefined;
	}

	#appendText(text: string): void {
		if (text.length === 0) return;
		this.#endThinking();
		if (this.#textIndex === undefined) {
			this.output.content.push({ type: "text", text: "" });
			this.#textIndex = this.output.content.length - 1;
			this.#stream.push({ type: "text_start", contentIndex: this.#textIndex, partial: this.output });
		}
		const block = this.output.content[this.#textIndex];
		if (block?.type === "text") {
			block.text += text;
			this.#stream.push({ type: "text_delta", contentIndex: this.#textIndex, delta: text, partial: this.output });
		}
		this.#firstTokenTime ??= performance.now();
	}

	#appendThinking(thinking: string): void {
		if (thinking.length === 0) return;
		this.#endText();
		if (this.#thinkingIndex === undefined) {
			this.output.content.push({ type: "thinking", thinking: "" });
			this.#thinkingIndex = this.output.content.length - 1;
			this.#stream.push({ type: "thinking_start", contentIndex: this.#thinkingIndex, partial: this.output });
		}
		const block = this.output.content[this.#thinkingIndex];
		if (block?.type === "thinking") {
			block.thinking += thinking;
			this.#stream.push({
				type: "thinking_delta",
				contentIndex: this.#thinkingIndex,
				delta: thinking,
				partial: this.output,
			});
		}
		this.#firstTokenTime ??= performance.now();
	}

	/** Open a tool-call block holding `partialJson` as its arguments so far, and return its index. */
	#openToolCall(id: string, name: string, partialJson: string): number {
		const toolCall: InternalToolCallBlock = {
			type: "toolCall",
			id,
			name,
			arguments: parseStreamingJson<Record<string, unknown>>(partialJson),
			[kStreamingPartialJson]: partialJson,
		};
		this.output.content.push(toolCall);
		const index = this.output.content.length - 1;
		this.#stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
		this.#stream.push({ type: "toolcall_delta", contentIndex: index, delta: partialJson, partial: this.output });
		this.#firstTokenTime ??= performance.now();
		return index;
	}

	/** A call the healer recovered from text arrives whole, so it opens and closes at once. */
	#emitHealedToolCall(call: HealedToolCall): void {
		this.#endThinking();
		this.#endText();
		endToolCallBlock(this.#stream, this.output, this.#openToolCall(call.id, call.name, call.arguments));
	}

	#openStructuredCalls(calls: readonly OllamaChunkToolCall[]): void {
		this.#endThinking();
		this.#endText();
		for (const call of calls) {
			const name = call.function?.name ?? "unknown_tool";
			const rawArgs = call.function?.arguments;
			const partialJson = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
			this.#toolIndices.add(this.#openToolCall(`ollama:${this.output.content.length}:${name}`, name, partialJson));
		}
	}
}

const streamOllamaOnce = (
	model: Model<"ollama-chat">,
	context: Context,
	options: OllamaChatOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const turn = new OllamaTurn(model, stream);
	void (async () => {
		const request: OllamaRequestRecord = {};
		try {
			const body = await openOllamaResponse(model, context, options, request);
			stream.push({ type: "start", partial: turn.output });
			for await (const chunk of iterateNdjson(body)) {
				turn.consume(chunk);
			}
			turn.finish();
		} catch (error) {
			await turn.fail(error, request);
		}
	})();
	return stream;
};

/** Retry EOS-only Ollama completions before the agent loop sees an empty stop. */
export const streamOllama: StreamFunction<"ollama-chat"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOllamaOnce);
