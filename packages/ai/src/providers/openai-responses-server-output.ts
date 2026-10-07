/**
 * Outbound OpenAI Responses objects for the auth-gateway: the output items an
 * {@link AssistantMessage} becomes, its usage, the response envelope and the ids they carry.
 *
 * {@link encodeResponse} writes a finished message as one JSON response.
 * `openai-responses-server-stream.ts` writes the same items event by event and ends the stream
 * with the items {@link buildOutputItems} builds from the final message.
 */

import { isRecord } from "@veyyon/utils/type-guards";
import type { AssistantMessage, ThinkingContent, ToolCall } from "../types";
import { parseTextSignature } from "./openai-shared";

export type AssistantItemPhase = "commentary" | "final_answer";
export type MessageSignature = { id: string; phase?: AssistantItemPhase };

export function stringOrUndefined(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/**
 * Whether two text blocks belong to one assistant `message` item: both carry no signature, or both
 * carry the same item id and phase.
 */
export function sameMessageSignature(a: MessageSignature | undefined, b: MessageSignature | undefined): boolean {
	if (!a || !b) return a === b;
	return a.id === b.id && a.phase === b.phase;
}

// ─── ids ────────────────────────────────────────────────────────────────────

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

/**
 * pi-ai responses providers mint composite `"{call_id}|{item_id}"` tool-call
 * ids ({@link encodeResponsesToolCallId}). Only the call_id half belongs on
 * the wire: third-party clients validate the `call_id` charset
 * (`^[a-zA-Z0-9_-]+$`) or echo it to other backends, and `|` fails both.
 */
export function wireCallId(id: string): string {
	const sep = id.indexOf("|");
	return sep >= 0 ? id.slice(0, sep) : id;
}

// ─── output items ───────────────────────────────────────────────────────────

export type ReasoningOutputItem = {
	type: "reasoning";
	id: string;
	summary: Array<{ type: "summary_text"; text: string }>;
} & Record<string, unknown>;

export type OutputText = { type: "output_text"; text: string; annotations: never[] };

export type MessageOutputItem = {
	type: "message";
	id: string;
	role: "assistant";
	status: "completed";
	content: OutputText[];
	phase?: AssistantItemPhase;
};

export type FunctionCallOutputItem = {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
};

export type CustomToolCallOutputItem = {
	type: "custom_tool_call";
	id: string;
	call_id: string;
	name: string;
	input: string;
	status: "completed";
};

export type OutputItem = ReasoningOutputItem | MessageOutputItem | FunctionCallOutputItem | CustomToolCallOutputItem;

/** The serialized Responses reasoning item a thinking block's signature holds, if it holds one. */
function signatureRecord(part: ThinkingContent): Record<string, unknown> | undefined {
	if (!part.thinkingSignature) return undefined;
	try {
		const parsed: unknown = JSON.parse(part.thinkingSignature);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function buildReasoningItem(part: ThinkingContent): ReasoningOutputItem {
	const baseId = part.itemId ?? makeReasoningId();
	const signature = signatureRecord(part);
	if (signature?.type === "reasoning") {
		const id = part.itemId ?? stringOrUndefined(signature.id) ?? makeReasoningId();
		// Preserve any extra fields (encrypted_content, …) the original carried,
		// but normalize the summary into the canonical `{type, text}[]` shape.
		const merged: Record<string, unknown> = { ...signature, type: "reasoning", id };
		merged.summary = [{ type: "summary_text", text: part.thinking }];
		// `content[]` is the encrypted/raw side-channel; leave whatever was
		// already there. If absent, omit — real OpenAI only emits `content[]`
		// when `include=['reasoning.encrypted_content']` is set.
		return merged as ReasoningOutputItem;
	}
	return {
		type: "reasoning",
		id: baseId,
		summary: [{ type: "summary_text", text: part.thinking }],
	};
}

export function reasoningItemId(part: ThinkingContent): string {
	if (part.itemId) return part.itemId;
	return stringOrUndefined(signatureRecord(part)?.id) || makeReasoningId();
}

export function functionCallItem(id: string, callId: string, name: string, args: string): FunctionCallOutputItem {
	return { type: "function_call", id, call_id: callId, name, arguments: args, status: "completed" };
}

export function customToolCallItem(id: string, callId: string, name: string, input: string): CustomToolCallOutputItem {
	return { type: "custom_tool_call", id, call_id: callId, name, input, status: "completed" };
}

function toolCallItem(part: ToolCall): FunctionCallOutputItem | CustomToolCallOutputItem {
	if (part.customWireName) {
		const input = part.arguments?.input;
		const id = part.thoughtSignature ?? makeCustomCallId();
		return customToolCallItem(id, wireCallId(part.id), part.customWireName, typeof input === "string" ? input : "");
	}
	const id = part.thoughtSignature ?? makeFuncCallId();
	return functionCallItem(id, wireCallId(part.id), part.name, JSON.stringify(part.arguments ?? {}));
}

/** An empty assistant message item opened under `signature`'s id and phase. */
function openMessageItem(signature: MessageSignature | undefined): MessageOutputItem {
	return {
		type: "message",
		id: signature?.id ?? makeMsgId(),
		role: "assistant",
		status: "completed",
		content: [],
		...(signature?.phase ? { phase: signature.phase } : {}),
	};
}

/**
 * Walk the assistant content array and group consecutive TextContent into a
 * single message item; each ThinkingContent / ToolCall is its own item.
 */
export function buildOutputItems(message: AssistantMessage): OutputItem[] {
	const out: OutputItem[] = [];
	let pendingMessage: MessageOutputItem | null = null;
	let pendingMessageSignature: MessageSignature | undefined;

	for (const part of message.content) {
		if (part.type === "text") {
			const signature = parseTextSignature(part.textSignature);
			if (!pendingMessage || !sameMessageSignature(pendingMessageSignature, signature)) {
				pendingMessage = openMessageItem(signature);
				pendingMessageSignature = signature;
				out.push(pendingMessage);
			}
			pendingMessage.content.push({ type: "output_text", text: part.text, annotations: [] });
			continue;
		}
		// RedactedThinking / Image are silently dropped — no direct Responses wire representation.
		if (part.type !== "thinking" && part.type !== "toolCall") continue;
		pendingMessage = null;
		out.push(part.type === "thinking" ? buildReasoningItem(part) : toolCallItem(part));
	}
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

// ─── response envelope ──────────────────────────────────────────────────────

export type ResponseStatus = "completed" | "in_progress" | "failed" | "incomplete";

export function responseStatusForStopReason(message: AssistantMessage): ResponseStatus {
	if (message.stopReason === "length") return "incomplete";
	if (message.stopReason === "error" || message.stopReason === "aborted") return "failed";
	return "completed";
}

export interface ResponseFields {
	id: string;
	/** Unix seconds. */
	createdAt: number;
	status: ResponseStatus;
	model: string;
	output: OutputItem[];
	usage: Record<string, unknown> | null;
	/** Reported under `error.message`; the envelope has no `error` key without it. */
	error?: string;
}

export function responseEnvelope(fields: ResponseFields): Record<string, unknown> {
	return {
		id: fields.id,
		object: "response",
		created_at: fields.createdAt,
		status: fields.status,
		model: fields.model,
		output: fields.output,
		usage: fields.usage,
		incomplete_details: fields.status === "incomplete" ? { reason: "max_output_tokens" } : null,
		...(fields.error !== undefined ? { error: { message: fields.error } } : {}),
	};
}

/** The error a finished message reports: its own message when it failed, nothing otherwise. */
export function failedMessageError(message: AssistantMessage, status: ResponseStatus): string | undefined {
	return status === "failed" ? (message.errorMessage ?? "response failed") : undefined;
}

// ─── encodeResponse (non-streaming) ─────────────────────────────────────────

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const output = buildOutputItems(message);
	const status = responseStatusForStopReason(message);
	return responseEnvelope({
		id: makeRespId(),
		createdAt: Math.floor(message.timestamp / 1000),
		status,
		model: requestedModelId,
		output,
		usage: buildUsage(message),
		error: failedMessageError(message, status),
	});
}
