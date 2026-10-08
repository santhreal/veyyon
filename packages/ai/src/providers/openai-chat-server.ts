import { randomUUID } from "node:crypto";
import { isEffort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { resolvePromptCacheKey } from "../auth-gateway/http";
/**
 * Parsed inbound OpenAI chat-completions request, ready to feed into pi-ai
 * `stream(model, context, options)`.
 */
import type {
	AuthGatewayStreamControl,
	FrameSink,
	AuthGatewayParsedRequest as ParsedRequest,
} from "../auth-gateway/types";
import * as AIError from "../error";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	StopReason,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	TSchema,
} from "../types";
import { isServiceTier } from "../types";
import { type } from "../utils/schema/arktype";
import {
	type OpenAIChatContentPart,
	type OpenAIChatMessage,
	type OpenAIChatTool,
	type OpenAIChatToolCall,
	type OpenAIChatToolChoice,
	openaiChatRequestSchema,
} from "./openai-chat-server-schema";

export type { ParsedRequest };

type RequestBody = typeof openaiChatRequestSchema.infer;

// ---------------------------------------------------------------------------
// parseRequest
// ---------------------------------------------------------------------------

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	// Header capture is centralized in `auth-gateway/server.ts` (allow-listed
	// headers like openai-organization/openai-project/openai-beta/x-stainless-*
	// land on `options.headers` automatically). We consult `headers` here too
	// for `resolvePromptCacheKey` to pull a cache identity out of inbound
	// vendor-neutral headers when the body doesn't carry one.
	const data = openaiChatRequestSchema(body);
	if (data instanceof type.errors) {
		throw new AIError.ValidationError(`openai-chat: ${data.summary}`);
	}

	const { systemPrompt, messages } = convertMessages(data.messages as OpenAIChatMessage[], data.model, Date.now());
	const tools = data.tools ? buildTools(data.tools as OpenAIChatTool[]) : undefined;
	const context: Context = {
		messages,
		...(systemPrompt !== undefined ? { systemPrompt: [systemPrompt] } : {}),
		...(tools ? { tools } : {}),
	};

	const options: ParsedRequest["options"] = {};
	applyGenerationOptions(data, options);
	applyRequestOptions(data, resolvePromptCacheKey(body, headers), options);

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options,
	};
}

/**
 * Converts the wire messages to canonical messages. Every non-empty `system` message joins one
 * system prompt, separated by a blank line; `systemPrompt` is undefined when there is none.
 */
function convertMessages(
	wire: readonly OpenAIChatMessage[],
	modelId: string,
	now: number,
): { systemPrompt: string | undefined; messages: Message[] } {
	const systemParts: string[] = [];
	const messages: Message[] = [];
	// Map of `tool_call_id` → function name, populated as we walk assistant
	// turns. The OpenAI wire spec drops `name` from `role:"tool"` messages,
	// but downstream providers (notably Google: `functionResponse.name` is
	// required) need it. We back-resolve from the matching call. If the
	// client did send a wire `name` we still prefer that (forward-compat).
	const toolNamesById = new Map<string, string>();

	for (const m of wire) {
		switch (m.role) {
			case "system": {
				const text = stringifyContent(m.content);
				if (text.length > 0) systemParts.push(text);
				break;
			}
			case "developer":
				messages.push({ role: "developer", content: parseUserLikeContent(m.content), timestamp: now });
				break;
			case "user":
				messages.push({ role: "user", content: parseUserLikeContent(m.content), timestamp: now });
				break;
			case "assistant": {
				const message = buildAssistantMessage(
					(m.content ?? undefined) as string | OpenAIChatContentPart[] | undefined,
					m.tool_calls,
					(m as { reasoning_content?: string | null }).reasoning_content ?? undefined,
					modelId,
					now,
				);
				recordToolCallNames(message, toolNamesById);
				messages.push(message);
				break;
			}
			case "tool": {
				// Prefer the wire `name` when present; otherwise back-resolve from
				// the assistant `tool_calls` map. Falls through to "" only when no
				// prior call shares this id, which is the well-known broken case.
				const wireName = (m as { name?: string }).name;
				const resolvedName = wireName ?? (m.tool_call_id ? toolNamesById.get(m.tool_call_id) : undefined);
				pushToolResultMessages(messages, m.content, m.tool_call_id, resolvedName, now);
				break;
			}
			case "function": {
				// Legacy `function` role (pre-tools API): the message carries the tool's
				// name on `name` and its output on `content`. Translate to a canonical
				// `toolResult` with a synthetic id (no original id on the wire).
				const fn = m as { role: "function"; name: string; content: string | null };
				pushToolResultMessages(messages, fn.content ?? "", undefined, fn.name, now);
				break;
			}
		}
	}

	return { systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages };
}

/** Maps the id of each tool call `message` makes to the call's name, skipping a call missing either. */
function recordToolCallNames(message: AssistantMessage, toolNamesById: Map<string, string>): void {
	for (const part of message.content) {
		if (part.type === "toolCall" && part.id && part.name) toolNamesById.set(part.id, part.name);
	}
}

/** Copies the request's decoding controls onto `options`, setting only the fields the request names. */
function applyGenerationOptions(data: RequestBody, options: ParsedRequest["options"]): void {
	// Prefer max_completion_tokens (newer) over max_tokens.
	const maxOutputTokens = data.max_completion_tokens ?? data.max_tokens;
	if (maxOutputTokens !== undefined) options.maxOutputTokens = maxOutputTokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	const stopSequences = normalizeStop(data.stop);
	if (stopSequences) options.stopSequences = stopSequences;
	// Schema accepts the Anthropic-style {type:'tool', name} variant that the SDK
	// union doesn't model; the normalizer collapses it to a plain name lookup.
	const toolChoice = normalizeToolChoice(data.tool_choice as OpenAIChatToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
	if (data.seed !== undefined) options.seed = data.seed;
	if (data.logit_bias !== undefined) options.logitBias = data.logit_bias;
}

/**
 * Copies the request's identity, output-shape and routing fields onto `options`, setting only the
 * fields the request names. An effort or service tier outside the known set is dropped.
 */
function applyRequestOptions(
	data: RequestBody,
	promptCacheKey: string | undefined,
	options: ParsedRequest["options"],
): void {
	if (data.user !== undefined) options.user = data.user;
	if (data.response_format !== undefined) options.responseFormat = data.response_format;
	if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
	if (isEffort(data.reasoning_effort)) options.reasoning = data.reasoning_effort;
	if (isServiceTier(data.service_tier)) options.serviceTier = data.service_tier;
	if (data.metadata !== undefined) options.metadata = data.metadata;
	if (promptCacheKey !== undefined) options.promptCacheKey = promptCacheKey;
	// `includeStreamingUsage` is the one opaque flag: the streaming encoder reads it
	// later off `options.extra`, which stays undefined when the request does not set it.
	if (data.stream_options?.include_usage === true) options.extra = { includeStreamingUsage: true };
}

function stringifyContent(content: string | OpenAIChatContentPart[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	const out: string[] = [];
	for (const part of content) {
		if (part.type === "text") out.push(part.text);
	}
	return out.join("");
}

function parseUserLikeContent(
	content: string | OpenAIChatContentPart[] | undefined,
): string | (TextContent | ImageContent)[] {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	const parts: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		const block = contentPartBlock(part);
		if (block) parts.push(block);
	}
	return parts;
}

/**
 * The canonical block for one wire content part: a text part as text, an image part as an image when
 * its URL is a data URI, and as a `[image: <url>]` text placeholder otherwise, since the gateway has
 * no image fetcher. Every other part type is accepted by the schema for forward compatibility and
 * has no canonical block, because canonical content models only text and images.
 */
function contentPartBlock(part: OpenAIChatContentPart): TextContent | ImageContent | undefined {
	if (part.type === "text") return { type: "text", text: part.text };
	if (part.type !== "image_url") return undefined;
	const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
	const decoded = decodeDataUri(url);
	return decoded
		? { type: "image", data: decoded.data, mimeType: decoded.mimeType }
		: { type: "text", text: `[image: ${url}]` };
}

function decodeDataUri(url: string): { data: string; mimeType: string } | undefined {
	if (!url.startsWith("data:")) return undefined;
	const comma = url.indexOf(",");
	if (comma < 0) return undefined;
	const header = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isBase64 = header.endsWith(";base64");
	const mimeType = (isBase64 ? header.slice(0, -";base64".length) : header) || "application/octet-stream";
	const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");
	return { data, mimeType };
}

function buildAssistantMessage(
	content: string | OpenAIChatContentPart[] | undefined,
	toolCalls: OpenAIChatToolCall[] | undefined,
	reasoningContent: string | undefined,
	modelId: string,
	now: number,
): AssistantMessage {
	const parts: AssistantMessage["content"] = [];
	if (reasoningContent !== undefined && reasoningContent.length > 0) {
		// Replayed reasoning channel. The signature names the wire field so
		// completions providers that demand exact `reasoning_content` replay
		// (DeepSeek/Kimi) echo the model's actual reasoning back verbatim.
		parts.push({ type: "thinking", thinking: reasoningContent, thinkingSignature: "reasoning_content" });
	}
	const text = stringifyContent(content);
	if (text.length > 0) parts.push({ type: "text", text });
	if (toolCalls) {
		for (const raw of toolCalls) {
			// Schema only accepts type:"function" (or omitted); narrow the SDK
			// union here so the custom-tool variant doesn't trip TS.
			if (raw.type !== undefined && raw.type !== "function") continue;
			const fn = (raw as { function: { name: string; arguments: string } }).function;
			parts.push({ type: "toolCall", id: raw.id, name: fn.name, arguments: parseToolCallArguments(fn.arguments) });
		}
	}
	return {
		role: "assistant",
		content: parts,
		api: "openai-completions",
		provider: "openai",
		model: modelId,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: now,
	};
}

/**
 * Parses a replayed call's JSON arguments. Empty text is no arguments; text that is not a JSON object
 * is kept whole under `__raw`, so the call reaches the provider with what the client sent.
 */
function parseToolCallArguments(text: string): Record<string, unknown> {
	if (text.length === 0) return {};
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : { __raw: text };
	} catch {
		return { __raw: text };
	}
}

/**
 * Walk a wire `tool` (or legacy `function`) message into canonical messages.
 * Tool-result content may carry images alongside text; pi-ai's
 * `ToolResultMessage` accepts both, but most downstream providers ignore
 * images on tool results. To mirror Rust's `encode_messages` behavior we
 * keep text inside the tool-result message and hoist any image parts into a
 * follow-up `user` message so they still reach the model.
 */
function pushToolResultMessages(
	messages: Message[],
	content: string | OpenAIChatContentPart[] | undefined | null,
	toolCallId: string | undefined,
	toolName: string | undefined,
	now: number,
): void {
	const textParts: TextContent[] = [];
	const imageParts: ImageContent[] = [];
	collectToolResultBlocks(content, textParts, imageParts);

	const toolMsg: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId ?? "",
		// OpenAI's `tool` role omits the tool name on the wire; the legacy
		// `function` role supplies it. Downstream providers tolerate empty.
		toolName: toolName ?? "",
		content: textParts.length > 0 ? textParts : [{ type: "text", text: "" }],
		isError: false,
		timestamp: now,
	};
	messages.push(toolMsg);

	if (imageParts.length > 0) {
		messages.push({
			role: "user",
			content: imageParts,
			timestamp: now,
		});
	}
}

/** Sorts a tool result's wire content into its text blocks and its image blocks, in wire order. */
function collectToolResultBlocks(
	content: string | OpenAIChatContentPart[] | undefined | null,
	textParts: TextContent[],
	imageParts: ImageContent[],
): void {
	if (typeof content === "string") {
		textParts.push({ type: "text", text: content });
		return;
	}
	if (!Array.isArray(content)) return;
	for (const part of content) {
		const block = contentPartBlock(part);
		if (block?.type === "image") imageParts.push(block);
		else if (block) textParts.push(block);
	}
}

function buildTools(tools: OpenAIChatTool[]): Tool[] | undefined {
	if (tools.length === 0) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		if (t.type !== "function") continue;
		out.push({
			name: t.function.name,
			description: t.function.description ?? "",
			parameters: (t.function.parameters ?? {}) as Record<string, unknown> as TSchema,
		});
	}
	return out;
}

function normalizeStop(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return [value];
	return value.length > 0 ? value : undefined;
}

function normalizeToolChoice(value: OpenAIChatToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "none" || value === "required") return value;
	if (typeof value === "object" && value !== null) {
		// OpenAI canonical: { type: 'function', function: { name } }
		if ("function" in value && value.function) return { name: value.function.name };
		// Anthropic-style passthrough (schema-allowed): { type: 'tool', name }
		const anthropicLike = value as unknown as { type?: string; name?: string };
		if (anthropicLike.type === "tool" && typeof anthropicLike.name === "string") {
			return { name: anthropicLike.name };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// encodeResponse (non-streaming)
// ---------------------------------------------------------------------------

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const { text, reasoning, toolCalls } = flattenAssistant(message);

	const responseMessage: Record<string, unknown> = {
		role: "assistant",
		content: text.length > 0 ? text : null,
		// pi-ai does not surface real refusals yet; emit `null` so SDKs that
		// probe `.refusal` see the documented field shape rather than missing.
		refusal: null,
	};
	if (reasoning.length > 0) {
		// DeepSeek-style / o-series reasoning channel.
		responseMessage.reasoning_content = reasoning;
	}
	if (toolCalls.length > 0) {
		responseMessage.tool_calls = toolCalls.map(tc => ({
			id: tc.id,
			type: "function",
			function: { name: tc.name, arguments: stringifyArgs(tc.arguments) },
		}));
	}

	return {
		id: makeId(),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: requestedModelId,
		// Real OpenAI always emits this key, even when the value is null. Mirror
		// the contract so probing SDKs do not throw on a missing field.
		system_fingerprint: null,
		choices: [
			{
				index: 0,
				message: responseMessage,
				finish_reason: mapFinishReason(message.stopReason, toolCalls.length > 0),
				logprobs: null,
			},
		],
		usage: buildUsage(message),
	};
}

function buildUsage(message: AssistantMessage): Record<string, unknown> {
	const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
	const usage: Record<string, unknown> = {
		prompt_tokens: promptTokens,
		completion_tokens: message.usage.output,
		total_tokens: promptTokens + message.usage.output,
		prompt_tokens_details: { cached_tokens: message.usage.cacheRead },
	};
	if (message.usage.reasoningTokens !== undefined) {
		usage.completion_tokens_details = { reasoning_tokens: message.usage.reasoningTokens };
	}
	return usage;
}

function flattenAssistant(message: AssistantMessage): {
	text: string;
	reasoning: string;
	toolCalls: ToolCall[];
} {
	let text = "";
	let reasoning = "";
	const toolCalls: ToolCall[] = [];
	for (const part of message.content) {
		switch (part.type) {
			case "text":
				text += part.text;
				break;
			case "thinking":
				reasoning += part.thinking;
				break;
			case "redactedThinking":
				// Opaque blob — surface verbatim on the reasoning channel so the
				// concatenation round-trips through clients that just echo it.
				reasoning += part.data;
				break;
			case "toolCall":
				toolCalls.push(part);
				break;
		}
	}
	return { text, reasoning, toolCalls };
}

function isOnlyRaw(args: Record<string, unknown>): boolean {
	for (const k in args) {
		if (k !== "__raw") return false;
	}
	return true;
}

function stringifyArgs(args: Record<string, unknown>): string {
	// `__raw` is our fallback marker for un-parseable inbound args; preserve it verbatim on the way out.
	if (typeof args.__raw === "string" && isOnlyRaw(args)) return args.__raw;
	try {
		return JSON.stringify(args);
	} catch {
		return "{}";
	}
}

function mapFinishReason(reason: StopReason, hasToolCalls: boolean): string {
	if (reason === "toolUse" || (hasToolCalls && reason === "stop")) return "tool_calls";
	if (reason === "length") return "length";
	// pi-ai's StopReason does not currently carry a content-filter signal;
	// when it does, map it to "content_filter" here.
	return "stop";
}

function makeId(): string {
	return `chatcmpl-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// encodeStream (SSE)
// ---------------------------------------------------------------------------

/** The id and name a tool call's start chunk sent. */
interface SentToolCall {
	id: string;
	name: string;
}

/**
 * The SSE frames for one streamed chat completion. {@link write} writes the role chunk and every
 * event's frames through the terminal one; {@link fail} reports a stream that threw.
 *
 * Tool calls take `tool_calls` indexes in the order they start, independent of their content index.
 */
class ChatCompletionStreamWriter {
	readonly #sink: FrameSink;
	readonly #id = makeId();
	readonly #created = Math.floor(Date.now() / 1000);
	readonly #model: string;
	readonly #includeUsage: boolean;
	/** Content index -> `tool_calls` index on the wire. */
	readonly #wireIndexByContentIndex = new Map<number, number>();
	/** Per wire index, what its start chunk sent, to correct an id or name that arrives later. */
	readonly #sentToolCalls: SentToolCall[] = [];
	/** Every chunk frame up to its delta: the fields each chunk of one response repeats, serialized once. */
	readonly #chunkHead: string;
	/** Every chunk frame after its finish reason. */
	readonly #chunkTail: string;

	constructor(sink: FrameSink, model: string, includeUsage: boolean) {
		this.#sink = sink;
		this.#model = model;
		this.#includeUsage = includeUsage;
		this.#chunkHead = `data: {"id":${JSON.stringify(this.#id)},"object":"chat.completion.chunk","created":${this.#created},"model":${JSON.stringify(model)},"system_fingerprint":null,"choices":[{"index":0,"delta":`;
		this.#chunkTail = `,"logprobs":null}]${includeUsage ? ',"usage":null' : ""}}\n\n`;
	}

	/**
	 * Writes the response through its last frame. True when the response is complete: a `done` or
	 * `error` event ended it, or the stream ended without one and finished as a normal stop. False
	 * when the sink was cancelled first.
	 */
	async write(events: AssistantMessageEventStream): Promise<boolean> {
		this.#emitChunk({ role: "assistant" }, null);
		for await (const event of events) {
			if (this.#sink.cancelled) return false;
			if (this.#apply(event)) return true;
		}
		if (this.#sink.cancelled) return false;
		this.#finish("stop", undefined);
		return true;
	}

	fail(error: unknown): void {
		this.#emitError(errorMessage(error));
	}

	/** Writes the frames `event` produces. True once the event ended the response. */
	#apply(event: AssistantMessageEvent): boolean {
		switch (event.type) {
			case "text_delta":
				if (event.delta.length > 0) this.#emitChunk({ content: event.delta }, null);
				return false;
			case "thinking_delta":
				// DeepSeek-style / o-series reasoning channel. Clients that don't
				// understand it ignore the unknown delta key.
				if (event.delta.length > 0) this.#emitChunk({ reasoning_content: event.delta }, null);
				return false;
			case "toolcall_start":
				this.#toolCallStart(event.partial, event.contentIndex);
				return false;
			case "toolcall_delta":
				this.#toolCallDelta(event.contentIndex, event.delta);
				return false;
			case "toolcall_end":
				this.#toolCallEnd(event.contentIndex, event.toolCall);
				return false;
			case "done":
				this.#finish(event.reason, event.message);
				return true;
			case "error":
				this.#emitError(event.error.errorMessage ?? "stream error");
				return true;
			// Drop start / *_start and text/thinking *_end — chat-completions
			// wire only surfaces deltas and the terminal finish_reason.
			default:
				return false;
		}
	}

	#toolCallStart(partial: AssistantMessage, contentIndex: number): void {
		const index = this.#sentToolCalls.length;
		this.#wireIndexByContentIndex.set(contentIndex, index);
		const part = partial.content[contentIndex];
		const call = part?.type === "toolCall" ? part : undefined;
		const sent: SentToolCall = { id: call?.id ?? "", name: call?.name ?? "" };
		this.#sentToolCalls.push(sent);
		this.#emitChunk(
			{ tool_calls: [{ index, id: sent.id, type: "function", function: { name: sent.name, arguments: "" } }] },
			null,
		);
	}

	#toolCallDelta(contentIndex: number, delta: string): void {
		const index = this.#wireIndexByContentIndex.get(contentIndex);
		if (index === undefined) return;
		this.#emitChunk({ tool_calls: [{ index, function: { arguments: delta } }] }, null);
	}

	/**
	 * Upstream completions providers can receive the real id/name in a later chunk than
	 * toolcall_start. Emit a corrective chunk only when the streamed value was empty: accumulating
	 * clients concatenate string fields, so "" + value is the only safe correction.
	 */
	#toolCallEnd(contentIndex: number, call: ToolCall): void {
		const index = this.#wireIndexByContentIndex.get(contentIndex);
		if (index === undefined) return;
		const sent = this.#sentToolCalls[index];
		const id = sent.id === "" && call.id !== "" ? call.id : undefined;
		const name = sent.name === "" && call.name !== "" ? call.name : undefined;
		if (id === undefined && name === undefined) return;
		const correction = {
			index,
			...(id !== undefined ? { id } : {}),
			...(name !== undefined ? { function: { name } } : {}),
		};
		this.#emitChunk({ tool_calls: [correction] }, null);
	}

	/** The finish chunk, the usage chunk when the client asked for one, then `[DONE]`. */
	#finish(reason: StopReason, message: AssistantMessage | undefined): void {
		this.#emitChunk({}, mapFinishReason(reason, this.#sentToolCalls.length > 0));
		if (message && this.#includeUsage) {
			this.#emit({
				id: this.#id,
				object: "chat.completion.chunk",
				created: this.#created,
				model: this.#model,
				system_fingerprint: null,
				choices: [],
				usage: buildUsage(message),
			});
		}
		this.#sink.enqueue("data: [DONE]\n\n");
	}

	#emitError(message: string): void {
		this.#emit({ error: { message, type: "upstream_error" } });
	}

	/** A `chat.completion.chunk` frame carrying `delta`. */
	#emitChunk(delta: Record<string, unknown>, finishReason: string | null): void {
		this.#send(
			`${this.#chunkHead}${JSON.stringify(delta)},"finish_reason":${JSON.stringify(finishReason)}${this.#chunkTail}`,
		);
	}

	#emit(payload: unknown): void {
		this.#send(`data: ${JSON.stringify(payload)}\n\n`);
	}

	#send(frame: string): void {
		if (!this.#sink.cancelled) this.#sink.enqueue(frame);
	}
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	options?: ParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const includeUsage = options?.extra?.includeStreamingUsage === true;
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const sink: FrameSink = {
				get cancelled() {
					return cancelled;
				},
				enqueue: frame => controller.enqueue(encoder.encode(frame)),
			};
			const writer = new ChatCompletionStreamWriter(sink, requestedModelId, includeUsage);
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				if (await writer.write(events)) controller.close();
			} catch (err) {
				if (!cancelled) {
					writer.fail(err);
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
		},
	});
}

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

/**
 * OpenAI chat-completions error envelope:
 *   `{ error: { message, type } }`
 * Matches the shape the official SDK auto-parses into `APIError`.
 */
export { formatOpenAiError as formatError } from "./openai-shared";
