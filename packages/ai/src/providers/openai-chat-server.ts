import { randomUUID } from "node:crypto";
import { isEffort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { type } from "arktype";
import { resolvePromptCacheKey } from "../auth-gateway/http";
import type { AuthGatewayStreamControl, AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import * as AIError from "../error";
import type {
	AssistantMessage,
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
import {
	type OpenAIChatContentPart,
	type OpenAIChatMessage,
	type OpenAIChatTool,
	type OpenAIChatToolCall,
	type OpenAIChatToolChoice,
	openaiChatRequestSchema,
} from "./openai-chat-server-schema";

export type { ParsedRequest };

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	const parsed = openaiChatRequestSchema(body);
	if (parsed instanceof type.errors) {
		throw new AIError.ValidationError(`openai-chat: ${parsed.summary}`);
	}
	const data = parsed;

	const now = Date.now();
	const systemParts: string[] = [];
	const messages: Message[] = [];
	const toolNamesById = new Map<string, string>();

	for (const m of data.messages as OpenAIChatMessage[]) {
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
			case "assistant":
				if (m.tool_calls) {
					for (const raw of m.tool_calls) {
						if (raw.type !== undefined && raw.type !== "function") continue;
						const fn = (raw as { function?: { name?: string } }).function;
						if (raw.id && fn?.name) toolNamesById.set(raw.id, fn.name);
					}
				}
				messages.push(
					buildAssistantMessage(
						(m.content ?? undefined) as string | OpenAIChatContentPart[] | undefined,
						m.tool_calls,
						(m as { reasoning_content?: string | null }).reasoning_content ?? undefined,
						data.model,
						now,
					),
				);
				break;
			case "tool": {
				const wireName = (m as { name?: string }).name;
				const resolvedName = wireName ?? (m.tool_call_id ? toolNamesById.get(m.tool_call_id) : undefined);
				pushToolResultMessages(messages, m.content, m.tool_call_id, resolvedName, now);
				break;
			}
			case "function": {
				const fn = m as { role: "function"; name: string; content: string | null };
				pushToolResultMessages(messages, fn.content ?? "", undefined, fn.name, now);
				break;
			}
		}
	}

	const tools = data.tools ? buildTools(data.tools as OpenAIChatTool[]) : undefined;

	const context: Context = {
		messages,
		...(systemParts.length > 0 ? { systemPrompt: [systemParts.join("\n\n")] } : {}),
		...(tools ? { tools } : {}),
	};

	const maxOutputTokens = data.max_completion_tokens ?? data.max_tokens;
	const stopSequences = normalizeStop(data.stop);
	const toolChoice = normalizeToolChoice(data.tool_choice as Parameters<typeof normalizeToolChoice>[0]);
	const includeStreamingUsage = data.stream_options?.include_usage === true;

	const extra: Record<string, unknown> = {};
	let hasExtra = false;
	if (includeStreamingUsage) {
		extra.includeStreamingUsage = true;
		hasExtra = true;
	}

	const options: ParsedRequest["options"] = {};
	if (maxOutputTokens !== undefined) options.maxOutputTokens = maxOutputTokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (stopSequences) options.stopSequences = stopSequences;
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
	if (data.seed !== undefined) options.seed = data.seed;
	if (data.logit_bias !== undefined) options.logitBias = data.logit_bias;
	if (data.user !== undefined) options.user = data.user;
	if (data.response_format !== undefined) options.responseFormat = data.response_format;
	if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
	if (data.reasoning_effort !== undefined && isEffort(data.reasoning_effort)) {
		options.reasoning = data.reasoning_effort;
	}
	if (data.service_tier !== undefined && isServiceTier(data.service_tier)) {
		options.serviceTier = data.service_tier;
	}
	if (data.metadata !== undefined) options.metadata = data.metadata;
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	if (hasExtra) options.extra = extra;

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options,
	};
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
		if (part.type === "text") {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type !== "image_url") continue;
		const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
		const decoded = decodeDataUri(url);
		if (decoded) {
			parts.push({ type: "image", data: decoded.data, mimeType: decoded.mimeType });
		} else {
			parts.push({ type: "text", text: `[image: ${url}]` });
		}
	}
	return parts;
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
		parts.push({ type: "thinking", thinking: reasoningContent, thinkingSignature: "reasoning_content" });
	}
	const text = stringifyContent(content);
	if (text.length > 0) parts.push({ type: "text", text });
	if (toolCalls) {
		for (const raw of toolCalls) {
			if (raw.type !== undefined && raw.type !== "function") continue;
			const fn = (raw as { function: { name: string; arguments: string } }).function;
			const argsStr = fn.arguments;
			let args: Record<string, unknown> = {};
			if (argsStr.length > 0) {
				try {
					const v: unknown = JSON.parse(argsStr);
					args = isRecord(v) ? (v as Record<string, unknown>) : { __raw: argsStr };
				} catch {
					args = { __raw: argsStr };
				}
			}
			const call: ToolCall = { type: "toolCall", id: raw.id, name: fn.name, arguments: args };
			parts.push(call);
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

function pushToolResultMessages(
	messages: Message[],
	content: string | OpenAIChatContentPart[] | undefined | null,
	toolCallId: string | undefined,
	toolName: string | undefined,
	now: number,
): void {
	const textParts: TextContent[] = [];
	const imageParts: ImageContent[] = [];

	if (typeof content === "string") {
		if (content.length > 0) textParts.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const part of content) {
			if (part.type === "text") {
				textParts.push({ type: "text", text: part.text });
				continue;
			}
			if (part.type !== "image_url") continue;
			const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
			const decoded = decodeDataUri(url);
			if (decoded) {
				imageParts.push({ type: "image", data: decoded.data, mimeType: decoded.mimeType });
			} else {
				textParts.push({ type: "text", text: `[image: ${url}]` });
			}
		}
	}

	const toolMsg: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId ?? "",
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
		if ("function" in value && value.function) return { name: value.function.name };
		const anthropicLike = value as unknown as { type?: string; name?: string };
		if (anthropicLike.type === "tool" && typeof anthropicLike.name === "string") {
			return { name: anthropicLike.name };
		}
	}
	return undefined;
}

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const { text, reasoning, toolCalls } = flattenAssistant(message);

	const responseMessage: Record<string, unknown> = {
		role: "assistant",
		content: text.length > 0 ? text : null,
		refusal: null,
	};
	if (reasoning.length > 0) {
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
	return "stop";
}

function makeId(): string {
	return `chatcmpl-${randomUUID()}`;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	options?: ParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const id = makeId();
	const created = Math.floor(Date.now() / 1000);
	const includeUsage = options?.extra?.includeStreamingUsage === true;
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });

	const baseChunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model: requestedModelId,
		system_fingerprint: null,
		choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
		...(includeUsage ? { usage: null } : {}),
	});

	const writeSse = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown): void => {
		if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
	};

	const writeUsage = (controller: ReadableStreamDefaultController<Uint8Array>, message: AssistantMessage): void => {
		writeSse(controller, {
			id,
			object: "chat.completion.chunk",
			created,
			model: requestedModelId,
			system_fingerprint: null,
			choices: [],
			usage: buildUsage(message),
		});
	};

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const toolIndexByContentIndex = new Map<number, number>();
			const sentToolMeta = new Map<number, { id: string; name: string }>();
			let nextToolIndex = 0;
			let hasToolCalls = false;
			let finishReason: string = "stop";

			try {
				if (cancelled) {
					controller.close();
					return;
				}
				writeSse(controller, baseChunk({ role: "assistant" }, null));

				for await (const event of events) {
					if (cancelled) return;
					switch (event.type) {
						case "text_delta":
							if (event.delta.length > 0) {
								writeSse(controller, baseChunk({ content: event.delta }, null));
							}
							break;

						case "thinking_delta":
							if (event.delta.length > 0) {
								writeSse(controller, baseChunk({ reasoning_content: event.delta }, null));
							}
							break;

						case "toolcall_start": {
							hasToolCalls = true;
							const idx = nextToolIndex++;
							toolIndexByContentIndex.set(event.contentIndex, idx);
							const partial = event.partial.content[event.contentIndex];
							const call = partial && partial.type === "toolCall" ? partial : undefined;
							sentToolMeta.set(idx, { id: call?.id ?? "", name: call?.name ?? "" });
							writeSse(
								controller,
								baseChunk(
									{
										tool_calls: [
											{
												index: idx,
												id: call?.id ?? "",
												type: "function",
												function: { name: call?.name ?? "", arguments: "" },
											},
										],
									},
									null,
								),
							);
							break;
						}

						case "toolcall_delta": {
							const idx = toolIndexByContentIndex.get(event.contentIndex);
							if (idx === undefined) break;
							writeSse(
								controller,
								baseChunk({ tool_calls: [{ index: idx, function: { arguments: event.delta } }] }, null),
							);
							break;
						}

						case "toolcall_end": {
							const idx = toolIndexByContentIndex.get(event.contentIndex);
							if (idx === undefined) break;
							const sent = sentToolMeta.get(idx);
							if (sent === undefined) break;
							const correctId = sent.id === "" && event.toolCall.id !== "" ? event.toolCall.id : undefined;
							const correctName =
								sent.name === "" && event.toolCall.name !== "" ? event.toolCall.name : undefined;
							if (correctId !== undefined || correctName !== undefined) {
								writeSse(
									controller,
									baseChunk(
										{
											tool_calls: [
												{
													index: idx,
													...(correctId !== undefined ? { id: correctId } : {}),
													...(correctName !== undefined ? { function: { name: correctName } } : {}),
												},
											],
										},
										null,
									),
								);
							}
							break;
						}

						case "done":
							finishReason =
								event.reason === "toolUse"
									? "tool_calls"
									: event.reason === "length"
										? "length"
										: hasToolCalls
											? "tool_calls"
											: "stop";
							writeSse(controller, baseChunk({}, finishReason));
							if (includeUsage) writeUsage(controller, event.message);
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
							return;

						case "error": {
							const msg = event.error.errorMessage ?? "stream error";
							writeSse(controller, { error: { message: msg, type: "upstream_error" } });
							controller.close();
							return;
						}

						default:
							break;
					}
				}

				if (!cancelled) {
					writeSse(controller, baseChunk({}, hasToolCalls ? "tool_calls" : "stop"));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				}
			} catch (err) {
				if (!cancelled) {
					const msg = errorMessage(err);
					writeSse(controller, { error: { message: msg, type: "upstream_error" } });
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

export { formatOpenAiError as formatError } from "./openai-shared";
