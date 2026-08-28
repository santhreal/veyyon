import { isEffort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import { type } from "arktype";
import { resolvePromptCacheKey } from "../auth-gateway/http";
import type { AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import * as AIError from "../error";
import type { AssistantMessage, Context, Message, TextContent, ThinkingContent, Tool, ToolCall } from "../types";
import { isServiceTier } from "../types";
import {
	type OpenAIResponsesFunctionCallItem,
	type OpenAIResponsesFunctionCallOutputItem,
	type OpenAIResponsesInputContent,
	type OpenAIResponsesOutputContent,
	type OpenAIResponsesReasoningItem,
	type OpenAIResponsesTool,
	openaiResponsesRequestSchema,
} from "./openai-responses-server-schema";
import { encodeTextSignatureV1, parseTextSignature } from "./openai-shared";

export {
	encodeResponse,
	encodeStream,
} from "./openai-responses-server-helpers";
export type { ParsedRequest };

function stringOrUndefined(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

type AssistantItemPhase = "commentary" | "final_answer";
export type MessageSignature = { id: string; phase?: AssistantItemPhase };

function parseAssistantItemPhase(value: unknown): AssistantItemPhase | undefined {
	return value === "commentary" || value === "final_answer" ? value : undefined;
}

function messageTextSignature(id: unknown, phase: unknown): string | undefined {
	const parsedPhase = parseAssistantItemPhase(phase);
	if (typeof id === "string" && id.length > 0) return encodeTextSignatureV1(id, parsedPhase);
	if (!parsedPhase) return undefined;
	return encodeTextSignatureV1(makeMsgId(), parsedPhase);
}

function uuidNoDashes(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

export function makeRespId(): string {
	return `resp_${uuidNoDashes()}`;
}

export function makeMsgId(): string {
	return `msg_${uuidNoDashes()}`;
}

export function makeReasoningId(): string {
	return `rs_${uuidNoDashes()}`;
}

export function makeFuncCallId(): string {
	return `fc_${uuidNoDashes()}`;
}

export function makeCustomCallId(): string {
	return `ctc_${uuidNoDashes()}`;
}

let warnedImageNotSupported = false;
let warnedFileNotSupported = false;
let warnedReasoningSummaryLevel = false;

function extractReasoningTextFromItem(item: OpenAIResponsesReasoningItem): string {
	const fromSummary = (item.summary ?? []).map(c => c.text).join("");
	if (fromSummary) return fromSummary;
	return (item.content ?? []).map(c => c.text).join("");
}

type InputBlockUnion =
	| { type: "input_text"; text: string }
	| { type: "text"; text: string }
	| { type: "input_image"; detail?: "auto" | "low" | "high"; image_url?: string; file_id?: string }
	| { type: "input_file"; file_id?: string; filename?: string; file_data?: string };

function inputContentParts(blocks: OpenAIResponsesInputContent[] | string | undefined): string | TextContent[] {
	if (typeof blocks === "string") return blocks;
	if (!blocks) return [];
	const parts: TextContent[] = [];
	for (const raw of blocks) {
		const block = raw as InputBlockUnion;
		if (block.type === "input_text" || block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "input_image") {
			if (!warnedImageNotSupported) {
				warnedImageNotSupported = true;
				logger.warn("openai-responses-server: input_image dropped (no pi-ai bridge for image_url/file_id)", {
					hasUrl: typeof block.image_url === "string",
					hasFileId: typeof block.file_id === "string",
				});
			}
			const ref = block.image_url ?? block.file_id ?? "?";
			parts.push({ type: "text", text: `[image: ${ref}]` });
		} else if (block.type === "input_file") {
			if (!warnedFileNotSupported) {
				warnedFileNotSupported = true;
				logger.warn("openai-responses-server: input_file dropped (no pi-ai bridge for file_id/file_data)", {
					hasFileId: typeof block.file_id === "string",
					hasFileData: typeof block.file_data === "string",
				});
			}
			const ref = block.file_id ?? block.filename ?? "?";
			parts.push({ type: "text", text: `[file: ${ref}]` });
		}
	}
	return parts.length === 1 ? parts[0].text : parts;
}

type OutputBlockUnion =
	| { type: "output_text"; text: string }
	| { type: "text"; text: string }
	| { type: "refusal"; refusal: string };

function outputTextOf(
	blocks: OpenAIResponsesOutputContent[] | string | undefined,
	message?: { id?: unknown; phase?: unknown },
): TextContent[] {
	const textSignature = messageTextSignature(message?.id, message?.phase);
	const textContent = (text: string): TextContent =>
		textSignature ? { type: "text", text, textSignature } : { type: "text", text };
	if (typeof blocks === "string") return blocks.length > 0 ? [textContent(blocks)] : [];
	if (!blocks) return [];
	const parts: string[] = [];
	for (const raw of blocks) {
		const block = raw as OutputBlockUnion;
		if (block.type === "output_text" || block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "refusal") {
			parts.push(`[refusal: ${block.refusal}]`);
		}
	}
	const text = parts.join("");
	return text.length > 0 ? [textContent(text)] : [];
}

type ParsedToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; name: string }
	| { type: "custom"; name: string }
	| {
			type:
				| "web_search_preview"
				| "file_search"
				| "computer_use_preview"
				| "code_interpreter"
				| "image_generation"
				| "mcp";
	  }
	| { type: "allowed_tools"; mode: "auto" | "required"; tools: Array<{ type: string; name?: string }> };

function mapToolChoice(value: ParsedToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "none" || value === "required") return value;
	if ("type" in value) {
		if (value.type === "function" || value.type === "custom") return { name: value.name };
		return "auto";
	}
	return undefined;
}

function buildTools(tools: Array<OpenAIResponsesTool | { type: string }> | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		if (t.type !== "function") continue;
		const fn = t as Extract<OpenAIResponsesTool, { type: "function" }>;
		const tool: Tool = {
			name: fn.name,
			description: fn.description ?? "",
			parameters: (fn.parameters ?? {}) as Tool["parameters"],
		};
		if (fn.strict !== undefined && fn.strict !== null) tool.strict = fn.strict;
		out.push(tool);
	}
	return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: Message[], modelId: string, now: number): AssistantMessage {
	const last = messages[messages.length - 1];
	if (last && last.role === "assistant") return last;
	const placeholder: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: modelId,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: now,
	};
	messages.push(placeholder);
	return placeholder;
}

function flattenFunctionOutputArray(blocks: readonly unknown[]): string {
	const parts: string[] = [];
	for (const raw of blocks) {
		if (!isRecord(raw)) continue;
		const t = raw.type;
		if (t === "output_text" || t === "text") {
			const text = stringOrUndefined(raw.text);
			if (text) parts.push(text);
		} else if (t === "refusal") {
			const refusal = stringOrUndefined(raw.refusal);
			if (refusal) parts.push(`[refusal: ${refusal}]`);
		}
	}
	return parts.join("");
}

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	const data = openaiResponsesRequestSchema(body);
	if (data instanceof type.errors) {
		throw new AIError.ValidationError(`openai-responses: ${data.summary}`);
	}

	const now = Date.now();
	const messages: Message[] = [];
	const systemPrompt: string[] = [];

	if (typeof data.instructions === "string" && data.instructions.length > 0) {
		systemPrompt.push(data.instructions);
	}

	if (typeof data.input === "string") {
		messages.push({ role: "user", content: data.input, timestamp: now });
	} else if (data.input) {
		for (const item of data.input) {
			const effectiveType = item.type ?? ("role" in item ? "message" : undefined);
			if (effectiveType === "message") {
				const msg = item as {
					role?: string;
					content?: OpenAIResponsesInputContent[] | OpenAIResponsesOutputContent[] | string;
					id?: unknown;
					phase?: unknown;
				};
				switch (msg.role) {
					case "system": {
						const text = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						const flat = typeof text === "string" ? text : text.map(p => p.text).join("");
						if (flat.length > 0) systemPrompt.push(flat);
						break;
					}
					case "user":
					case "developer": {
						const content = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						messages.push({ role: msg.role, content, timestamp: now });
						break;
					}
					case "assistant": {
						const parts = outputTextOf(msg.content as OpenAIResponsesOutputContent[] | string | undefined, {
							id: msg.id,
							phase: msg.phase,
						});
						messages.push({
							role: "assistant",
							content: parts,
							api: "openai-responses",
							provider: "openai",
							model: data.model,
							usage: emptyUsage(),
							stopReason: "stop",
							timestamp: now,
						});
						break;
					}
				}
				continue;
			}
			if (effectiveType === "reasoning") {
				const reasoning = item as OpenAIResponsesReasoningItem;
				const text = extractReasoningTextFromItem(reasoning);
				const thinking: ThinkingContent = {
					type: "thinking",
					thinking: text,
					thinkingSignature: JSON.stringify(reasoning),
					...(reasoning.id ? { itemId: reasoning.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(thinking);
				continue;
			}
			if (effectiveType === "function_call") {
				const call = item as OpenAIResponsesFunctionCallItem;
				const argsRaw = call.arguments ?? "{}";
				let args: Record<string, unknown>;
				try {
					const parsedArgs: unknown = JSON.parse(argsRaw);
					args = isRecord(parsedArgs) ? parsedArgs : {};
				} catch {
					throw new AIError.ValidationError(
						`openai-responses: function_call ${call.call_id} has invalid JSON arguments`,
					);
				}
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: call.name,
					arguments: args,
					...(call.id ? { thoughtSignature: call.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "custom_tool_call") {
				const call = item as { id?: string; call_id: string; name: string; input: string };
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: call.name,
					arguments: { input: call.input ?? "" },
					customWireName: call.name,
					...(call.id ? { thoughtSignature: call.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "function_call_output") {
				const output = item as OpenAIResponsesFunctionCallOutputItem;
				const toolName = findToolNameById(messages, output.call_id);
				const text =
					typeof output.output === "string"
						? output.output
						: Array.isArray(output.output)
							? flattenFunctionOutputArray(output.output)
							: "";
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName,
					content: [{ type: "text", text }],
					isError: false,
					timestamp: now,
				});
				continue;
			}
			if (effectiveType === "custom_tool_call_output") {
				const output = item as { call_id: string; output: string };
				const toolName = findToolNameById(messages, output.call_id);
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName,
					content: [{ type: "text", text: output.output ?? "" }],
					isError: false,
					timestamp: now,
				});
			}
		}
	}

	const tools = buildTools(data.tools);
	const context: Context = {
		...(systemPrompt.length > 0 ? { systemPrompt } : {}),
		messages,
		...(tools ? { tools } : {}),
	};

	const options: ParsedRequest["options"] = {};
	if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.stop !== undefined && data.stop !== null) {
		options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
	}
	const toolChoice = mapToolChoice(data.tool_choice as ParsedToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.reasoning?.effort && isEffort(data.reasoning.effort)) {
		options.reasoning = data.reasoning.effort;
	}
	if (data.reasoning?.summary === "none") {
		options.hideThinkingSummary = true;
	} else if (
		data.reasoning?.summary === "auto" ||
		data.reasoning?.summary === "concise" ||
		data.reasoning?.summary === "detailed"
	) {
		if (!warnedReasoningSummaryLevel) {
			warnedReasoningSummaryLevel = true;
			logger.debug("openai-responses-server: reasoning.summary level not differentiated", {
				level: data.reasoning.summary,
			});
		}
	}
	if (data.service_tier !== undefined && isServiceTier(data.service_tier)) {
		options.serviceTier = data.service_tier;
	}
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
	if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	if (data.previous_response_id !== undefined) options.previousResponseId = data.previous_response_id;
	if (data.user !== undefined) options.user = data.user;
	if (isRecord(data.metadata)) options.metadata = data.metadata;

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options,
	};
}

function findToolNameById(messages: Message[], callId: string): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		for (const c of m.content) {
			if (c.type === "toolCall" && c.id === callId) return c.name;
		}
	}
	return "";
}

export { formatOpenAiError as formatError } from "./openai-shared";

type ReasoningOutputItem = {
	type: "reasoning";
	id: string;
	summary: Array<{ type: "summary_text"; text: string }>;
} & Record<string, unknown>;

type MessageOutputItem = {
	type: "message";
	id: string;
	role: "assistant";
	status: "completed";
	content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
	phase?: AssistantItemPhase;
};

type FunctionCallOutputItem = {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
};

type CustomToolCallOutputItem = {
	type: "custom_tool_call";
	id: string;
	call_id: string;
	name: string;
	input: string;
	status: "completed";
};

export type OutputItem = ReasoningOutputItem | MessageOutputItem | FunctionCallOutputItem | CustomToolCallOutputItem;

export type ResponseStatus = "completed" | "in_progress" | "failed" | "incomplete";

export function responseStatusForStopReason(message: AssistantMessage): ResponseStatus {
	if (message.stopReason === "length") return "incomplete";
	if (message.stopReason === "error" || message.stopReason === "aborted") return "failed";
	return "completed";
}

export function incompleteDetailsForStatus(status: ResponseStatus): { reason: "max_output_tokens" } | null {
	return status === "incomplete" ? { reason: "max_output_tokens" } : null;
}

function buildReasoningItem(part: ThinkingContent): ReasoningOutputItem {
	const baseId = part.itemId ?? makeReasoningId();
	if (part.thinkingSignature) {
		try {
			const sigParsed: unknown = JSON.parse(part.thinkingSignature);
			if (isRecord(sigParsed) && sigParsed.type === "reasoning") {
				const id = part.itemId ?? stringOrUndefined(sigParsed.id) ?? makeReasoningId();
				const merged: Record<string, unknown> = { ...sigParsed, type: "reasoning", id };
				merged.summary = [{ type: "summary_text", text: part.thinking }];
				return merged as ReasoningOutputItem;
			}
		} catch {}
	}
	return {
		type: "reasoning",
		id: baseId,
		summary: [{ type: "summary_text", text: part.thinking }],
	};
}

export function reasoningItemId(part: ThinkingContent): string {
	if (part.itemId) return part.itemId;
	if (part.thinkingSignature) {
		try {
			const sigParsed: unknown = JSON.parse(part.thinkingSignature);
			if (isRecord(sigParsed)) {
				const id = stringOrUndefined(sigParsed.id);
				if (id) return id;
			}
		} catch {}
	}
	return makeReasoningId();
}

export function wireCallId(id: string): string {
	const sep = id.indexOf("|");
	return sep >= 0 ? id.slice(0, sep) : id;
}

export function buildOutputItems(message: AssistantMessage): OutputItem[] {
	const out: OutputItem[] = [];
	let pendingMessage: MessageOutputItem | null = null;
	let pendingMessageSignature: { id: string; phase?: AssistantItemPhase } | undefined;
	const flushMessage = () => {
		if (pendingMessage) {
			out.push(pendingMessage);
			pendingMessage = null;
			pendingMessageSignature = undefined;
		}
	};

	for (const part of message.content) {
		if (part.type === "text") {
			const signature = parseTextSignature(part.textSignature);
			const sameSignature =
				!pendingMessage ||
				(pendingMessageSignature?.id === signature?.id && pendingMessageSignature?.phase === signature?.phase);
			if (!sameSignature) flushMessage();
			if (!pendingMessage) {
				pendingMessage = {
					type: "message",
					id: signature?.id ?? makeMsgId(),
					role: "assistant",
					status: "completed",
					content: [],
					...(signature?.phase ? { phase: signature.phase } : {}),
				};
				pendingMessageSignature = signature;
			}
			pendingMessage.content.push({ type: "output_text", text: part.text, annotations: [] });
		} else if (part.type === "thinking") {
			flushMessage();
			out.push(buildReasoningItem(part));
		} else if (part.type === "toolCall") {
			flushMessage();
			if (part.customWireName) {
				const input = part.arguments?.input;
				const rawInput = typeof input === "string" ? input : "";
				out.push({
					type: "custom_tool_call",
					id: part.thoughtSignature ?? makeCustomCallId(),
					call_id: wireCallId(part.id),
					name: part.customWireName,
					input: rawInput,
					status: "completed",
				});
			} else {
				out.push({
					type: "function_call",
					id: part.thoughtSignature ?? makeFuncCallId(),
					call_id: wireCallId(part.id),
					name: part.name,
					arguments: JSON.stringify(part.arguments ?? {}),
					status: "completed",
				});
			}
		}
	}
	flushMessage();
	return out;
}

export function buildUsage(message: AssistantMessage): Record<string, unknown> {
	const u = message.usage;
	const inputTokens = u.input + u.cacheRead + u.cacheWrite;
	return {
		input_tokens: inputTokens,
		input_tokens_details: { cached_tokens: u.cacheRead },
		output_tokens: u.output,
		output_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 },
		total_tokens: inputTokens + u.output,
	};
}
