/**
 * OpenAI Responses HTTP wire-format ↔ veyyon Context bridge for the auth-gateway.
 *
 * Inbound: parses `POST /v1/responses` request bodies into a {@link ParsedRequest}.
 * Outbound: `openai-responses-server-output.ts` encodes veyyon's {@link AssistantMessage} as the
 * non-streaming JSON shape and `openai-responses-server-stream.ts` encodes its event stream as the
 * documented `response.*` SSE taxonomy; both are re-exported here as the gateway's format module.
 *
 * Spec: https://platform.openai.com/docs/api-reference/responses
 * Inverse direction (source-of-truth for item shapes): ../../providers/openai-responses.ts
 */

import { isEffort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import { resolvePromptCacheKey } from "../auth-gateway/http";
import type { AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import * as AIError from "../error";
import type { AssistantMessage, Context, Message, TextContent, ThinkingContent, Tool, ToolCall } from "../types";
import { isServiceTier } from "../types";
import { type } from "../utils/schema/arktype";
import { makeMsgId, stringOrUndefined } from "./openai-responses-server-output";
import {
	type OpenAIResponsesCustomToolCallItem,
	type OpenAIResponsesCustomToolCallOutputItem,
	type OpenAIResponsesFunctionCallItem,
	type OpenAIResponsesFunctionCallOutputItem,
	type OpenAIResponsesInputContent,
	type OpenAIResponsesOutputContent,
	type OpenAIResponsesReasoningItem,
	type OpenAIResponsesTool,
	openaiResponsesRequestSchema,
} from "./openai-responses-server-schema";
import { encodeTextSignatureV1 } from "./openai-shared";

export { encodeResponse } from "./openai-responses-server-output";
export { encodeStream } from "./openai-responses-server-stream";
export { formatOpenAiError as formatError } from "./openai-shared";
export type { ParsedRequest };

type RequestBody = typeof openaiResponsesRequestSchema.infer;
type RequestInputItem = Exclude<NonNullable<RequestBody["input"]>, string>[number];

// ─── once-only warnings ─────────────────────────────────────────────────────
// Module-scoped so we don't spam logs once per turn.

let warnedImageNotSupported = false;
let warnedFileNotSupported = false;
let warnedReasoningSummaryLevel = false;

// ─── inbound parser helpers ─────────────────────────────────────────────────

function messageTextSignature(id: unknown, phase: unknown): string | undefined {
	const parsedPhase = phase === "commentary" || phase === "final_answer" ? phase : undefined;
	if (typeof id === "string" && id.length > 0) return encodeTextSignatureV1(id, parsedPhase);
	if (!parsedPhase) return undefined;
	return encodeTextSignatureV1(makeMsgId(), parsedPhase);
}

function extractReasoningTextFromItem(item: OpenAIResponsesReasoningItem): string {
	// Prefer `summary[]` — mirrors real OpenAI and the openai-responses provider
	// which writes the surfaced reasoning summary into `summary[].text`.
	const fromSummary = (item.summary ?? []).map(c => c.text).join("");
	if (fromSummary) return fromSummary;
	return (item.content ?? []).map(c => c.text).join("");
}

type InputBlockUnion =
	| { type: "input_text"; text: string }
	| { type: "text"; text: string }
	| { type: "input_image"; detail?: "auto" | "low" | "high"; image_url?: string; file_id?: string }
	| { type: "input_file"; file_id?: string; filename?: string; file_data?: string };

/**
 * The text an `input_image` / `input_file` block stands in as. pi-ai's `ImageContent` only carries
 * inline base64 data and there is no resolver for OpenAI `image_url` / `file_id` references, so
 * each becomes a bracketed placeholder. Logs once per kind.
 */
function referencePlaceholder(block: Exclude<InputBlockUnion, { text: string }>): string {
	if (block.type === "input_image") {
		if (!warnedImageNotSupported) {
			warnedImageNotSupported = true;
			logger.warn("openai-responses-server: input_image dropped (no pi-ai bridge for image_url/file_id)", {
				hasUrl: typeof block.image_url === "string",
				hasFileId: typeof block.file_id === "string",
			});
		}
		return `[image: ${block.image_url ?? block.file_id ?? "?"}]`;
	}
	if (!warnedFileNotSupported) {
		warnedFileNotSupported = true;
		logger.warn("openai-responses-server: input_file dropped (no pi-ai bridge for file_id/file_data)", {
			hasFileId: typeof block.file_id === "string",
			hasFileData: typeof block.file_data === "string",
		});
	}
	return `[file: ${block.file_id ?? block.filename ?? "?"}]`;
}

/** Walk an input message's content array and produce pi-ai's `TextContent[]`. */
function inputContentParts(blocks: OpenAIResponsesInputContent[] | string | undefined): string | TextContent[] {
	if (typeof blocks === "string") return blocks;
	if (!blocks) return [];
	const parts: TextContent[] = [];
	for (const raw of blocks) {
		const block = raw as InputBlockUnion;
		if (block.type === "input_text" || block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "input_image" || block.type === "input_file") {
			parts.push({ type: "text", text: referencePlaceholder(block) });
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
			// Preserve the refusal reason so history replay still carries it.
			parts.push(`[refusal: ${block.refusal}]`);
		}
	}
	const text = parts.join("");
	return text.length > 0 ? [textContent(text)] : [];
}

// The schema accepts a much wider tool_choice union than the SDK type so the
// walker narrows against the local schema shape.
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
		// `custom` (codex apply_patch) and `function` both resolve to the same
		// pi-ai shape: pi-ai's dispatcher matches `Tool.name` AND `customWireName`,
		// so passing the wire name works for either.
		if (value.type === "function" || value.type === "custom") return { name: value.name };
		// Hosted tools + allowed_tools — we don't surface these to pi-ai; fall
		// back to letting the model pick a tool freely.
		return "auto";
	}
	return undefined;
}

function buildTools(tools: Array<OpenAIResponsesTool | { type: string }> | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		// Skip non-function tools (web_search, file_search, …).
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

/** Flatten a function_call_output array form (text + refusal) into a single string. */
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

// ─── input items ────────────────────────────────────────────────────────────

/** The conversation one request's input items are bridged into. */
interface InputBridge {
	readonly messages: Message[];
	readonly systemPrompt: string[];
	readonly model: string;
	readonly now: number;
}

function assistantTurn(into: InputBridge, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: into.model,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: into.now,
	};
}

/** The assistant turn reasoning and tool-call items join: the last message when it is one, else a new one. */
function openAssistantTurn(into: InputBridge): AssistantMessage {
	const last = into.messages[into.messages.length - 1];
	if (last && last.role === "assistant") return last;
	const placeholder = assistantTurn(into, []);
	into.messages.push(placeholder);
	return placeholder;
}

type MessageItem = {
	role?: string;
	content?: OpenAIResponsesInputContent[] | OpenAIResponsesOutputContent[] | string;
	id?: unknown;
	phase?: unknown;
};

function bridgeMessage(msg: MessageItem, into: InputBridge): void {
	switch (msg.role) {
		case "system": {
			const text = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
			const flat = typeof text === "string" ? text : text.map(p => p.text).join("");
			if (flat.length > 0) into.systemPrompt.push(flat);
			return;
		}
		case "user":
		case "developer": {
			const content = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
			into.messages.push({ role: msg.role, content, timestamp: into.now });
			return;
		}
		case "assistant": {
			const content = outputTextOf(msg.content as OpenAIResponsesOutputContent[] | string | undefined, {
				id: msg.id,
				phase: msg.phase,
			});
			into.messages.push(assistantTurn(into, content));
		}
	}
}

function bridgeReasoning(reasoning: OpenAIResponsesReasoningItem, into: InputBridge): void {
	const thinking: ThinkingContent = {
		type: "thinking",
		thinking: extractReasoningTextFromItem(reasoning),
		thinkingSignature: JSON.stringify(reasoning),
		...(reasoning.id ? { itemId: reasoning.id } : {}),
	};
	openAssistantTurn(into).content.push(thinking);
}

function bridgeFunctionCall(call: OpenAIResponsesFunctionCallItem, into: InputBridge): void {
	let parsedArgs: unknown;
	try {
		parsedArgs = JSON.parse(call.arguments ?? "{}");
	} catch {
		throw new AIError.ValidationError(`openai-responses: function_call ${call.call_id} has invalid JSON arguments`);
	}
	const toolCall: ToolCall = {
		type: "toolCall",
		id: call.call_id,
		name: call.name,
		arguments: isRecord(parsedArgs) ? parsedArgs : {},
		...(call.id ? { thoughtSignature: call.id } : {}),
	};
	openAssistantTurn(into).content.push(toolCall);
}

function bridgeCustomToolCall(call: OpenAIResponsesCustomToolCallItem, into: InputBridge): void {
	// Custom tools carry a raw input string. We stash it in `arguments.input`
	// matching pi-ai's openai-shared convention, and tag the call
	// with `customWireName` so encoders re-emit it as `custom_tool_call`.
	const toolCall: ToolCall = {
		type: "toolCall",
		id: call.call_id,
		name: call.name,
		arguments: { input: call.input },
		customWireName: call.name,
		...(call.id ? { thoughtSignature: call.id } : {}),
	};
	openAssistantTurn(into).content.push(toolCall);
}

function bridgeToolOutput(callId: string, text: string, into: InputBridge): void {
	into.messages.push({
		role: "toolResult",
		toolCallId: callId,
		toolName: findToolNameById(into.messages, callId),
		content: [{ type: "text", text }],
		isError: false,
		timestamp: into.now,
	});
}

function functionOutputText(output: OpenAIResponsesFunctionCallOutputItem["output"]): string {
	if (typeof output === "string") return output;
	return Array.isArray(output) ? flattenFunctionOutputArray(output) : "";
}

function bridgeInputItem(item: RequestInputItem, into: InputBridge): void {
	// Items may omit `type` and rely on `role` (the convenience shape).
	switch (item.type ?? ("role" in item ? "message" : undefined)) {
		case "message":
			return bridgeMessage(item as MessageItem, into);
		case "reasoning":
			return bridgeReasoning(item as OpenAIResponsesReasoningItem, into);
		case "function_call":
			return bridgeFunctionCall(item as OpenAIResponsesFunctionCallItem, into);
		case "custom_tool_call":
			return bridgeCustomToolCall(item as OpenAIResponsesCustomToolCallItem, into);
		case "function_call_output": {
			const output = item as OpenAIResponsesFunctionCallOutputItem;
			return bridgeToolOutput(output.call_id, functionOutputText(output.output), into);
		}
		case "custom_tool_call_output": {
			const output = item as OpenAIResponsesCustomToolCallOutputItem;
			return bridgeToolOutput(output.call_id, output.output, into);
		}
	}
	// Other item types are tolerated but not bridged.
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

// ─── request options ────────────────────────────────────────────────────────

/** Output length, sampling, stop sequences, tool choice and reasoning. */
function generationOptions(data: RequestBody, options: ParsedRequest["options"]): void {
	if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.stop !== undefined && data.stop !== null) {
		options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
	}
	const toolChoice = mapToolChoice(data.tool_choice as ParsedToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	const effort = data.reasoning?.effort;
	if (effort && isEffort(effort)) options.reasoning = effort;
	// OpenAI summary: `none` → suppress; `auto`/`concise`/`detailed` → request
	// visible summary. pi-ai has no per-level plumbing — log once and let the
	// provider default kick in.
	const summary = data.reasoning?.summary;
	if (summary === "none") {
		options.hideThinkingSummary = true;
	} else if (summary !== undefined && !warnedReasoningSummaryLevel) {
		warnedReasoningSummaryLevel = true;
		logger.debug("openai-responses-server: reasoning.summary level not differentiated", { level: summary });
	}
}

/** Service tier, penalties, parallel calls, cache identity, threading and caller metadata. */
function routingOptions(
	data: RequestBody,
	body: unknown,
	headers: Headers | undefined,
	options: ParsedRequest["options"],
): void {
	if (data.service_tier !== undefined && isServiceTier(data.service_tier)) {
		options.serviceTier = data.service_tier;
	}
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
	if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
	// Header capture is centralized in `auth-gateway/server.ts` (the allow-listed set lands on
	// `options.headers` automatically). `headers` is consulted here only for a cache identity the
	// client signals outside the body.
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	if (data.previous_response_id !== undefined) options.previousResponseId = data.previous_response_id;
	if (data.user !== undefined) options.user = data.user;
	if (isRecord(data.metadata)) options.metadata = data.metadata;
	// `store` is a stateful-storage hint that veyyon's gateway doesn't honour;
	// silently accepted by the schema. No typed slot — drop.
}

// ─── parseRequest ───────────────────────────────────────────────────────────

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	const data = openaiResponsesRequestSchema(body);
	if (data instanceof type.errors) {
		throw new AIError.ValidationError(`openai-responses: ${data.summary}`);
	}

	const into: InputBridge = { messages: [], systemPrompt: [], model: data.model, now: Date.now() };
	if (typeof data.instructions === "string" && data.instructions.length > 0) {
		into.systemPrompt.push(data.instructions);
	}
	if (typeof data.input === "string") {
		into.messages.push({ role: "user", content: data.input, timestamp: into.now });
	} else if (data.input) {
		for (const item of data.input) bridgeInputItem(item, into);
	}

	const tools = buildTools(data.tools);
	const context: Context = {
		...(into.systemPrompt.length > 0 ? { systemPrompt: into.systemPrompt } : {}),
		messages: into.messages,
		...(tools ? { tools } : {}),
	};
	const options: ParsedRequest["options"] = {};
	generationOptions(data, options);
	routingOptions(data, body, headers, options);
	return { modelId: data.model, context, stream: data.stream === true, options };
}
