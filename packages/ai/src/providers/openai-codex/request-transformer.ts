import { Effort } from "@veyyon/catalog/effort";
import {
	statesOpenAIWireGeneration,
	supportsAllTurnsReasoningContext,
	supportsCodexReasoningSummary,
} from "@veyyon/catalog/identity";
import { requireSupportedEffort } from "@veyyon/catalog/model-thinking";
import type { Model } from "../../types";
import { mapOpenAIReasoningEffort, ORPHAN_TOOL_CALL_PLACEHOLDER } from "../openai-shared";

export type CodexReasoningContext = "auto" | "current_turn" | "all_turns";

type CodexCallerEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_BY_NAME: Record<CodexCallerEffort, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	summary?: "auto" | "concise" | "detailed";
	context?: CodexReasoningContext;
	mode?: "pro";
}

export interface CodexRequestOptions {
	reasoningEffort?: CodexCallerEffort | "none";
	reasoningSummary?: ReasoningConfig["summary"] | null;
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	responsesLite?: boolean;
}

export interface InputItem {
	id?: string | null;
	type?: string | null;
	role?: string;
	content?: unknown;
	call_id?: string | null;
	name?: string;
	output?: unknown;
	arguments?: unknown;
	tools?: unknown;
}

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	tool_choice?: unknown;
	stream_options?: { reasoning_summary_delivery: "sequential_cutoff" };
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	client_metadata?: Record<string, string>;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	[key: string]: unknown;
}

type CodexReasoningContextModel = Pick<Model<"openai-codex-responses">, "id"> & { useResponsesLite?: boolean };

export function acceptsAllTurnsReasoningContext(model: CodexReasoningContextModel): boolean {
	if (supportsAllTurnsReasoningContext(model.id)) return true;
	return !statesOpenAIWireGeneration(model.id) && model.useResponsesLite === true;
}

export function resolveCodexResponsesLite(model: CodexReasoningContextModel, requested?: boolean): boolean {
	if (!acceptsAllTurnsReasoningContext(model)) {
		return false;
	}
	return requested ?? model.useResponsesLite === true;
}

function mapCodexWireEffort(
	model: Model<"openai-codex-responses">,
	effort: CodexCallerEffort,
): ReasoningConfig["effort"] {
	const mapped = mapOpenAIReasoningEffort(model, model.compat, requireSupportedEffort(model, EFFORT_BY_NAME[effort]));
	switch (mapped) {
		case "none":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return mapped;
		default:
			throw new Error(
				`Effort map for ${model.provider}/${model.id} produced invalid Codex reasoning effort "${mapped}"`,
			);
	}
}

function getReasoningConfig(
	model: Model<"openai-codex-responses">,
	effort: NonNullable<CodexRequestOptions["reasoningEffort"]>,
	options: CodexRequestOptions,
): ReasoningConfig {
	const config: ReasoningConfig = {
		effort: effort === "none" ? "none" : mapCodexWireEffort(model, effort),
	};
	if (options.reasoningSummary !== null && supportsCodexReasoningSummary(model.id)) {
		config.summary = options.reasoningSummary ?? "detailed";
	}
	return config;
}

function filterInput(input: InputItem[] | undefined): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter(item => item.type !== "item_reference")
		.map(item => {
			if (item.id != null) {
				const { id: _id, ...rest } = item;
				return rest as InputItem;
			}
			return item;
		});
}

const CODEX_ORPHAN_OUTPUT_LIMIT = 16_000;

function orphanFunctionOutputToMessage(item: InputItem, callId: string): InputItem {
	const itemRecord = item as unknown as Record<string, unknown>;
	const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "tool";
	let text = "";
	try {
		const output = itemRecord.output;
		text = typeof output === "string" ? output : JSON.stringify(output);
	} catch {
		text = String(itemRecord.output ?? "");
	}
	if (text.length > CODEX_ORPHAN_OUTPUT_LIMIT) {
		text = `${text.slice(0, CODEX_ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
	}
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${callId}]: ${text}`,
	} as InputItem;
}

function repairToolCallPairs(input: InputItem[]): InputItem[] {
	const callIds = new Set<string>();
	const outputCallIds = new Set<string>();
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;
		if (callId === undefined) continue;
		if (item.type === "function_call" || item.type === "custom_tool_call") callIds.add(callId);
		else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
			outputCallIds.add(callId);
		}
	}

	const repaired: InputItem[] = [];
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;

		if (
			(item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
			callId !== undefined &&
			!callIds.has(callId)
		) {
			repaired.push(orphanFunctionOutputToMessage(item, callId));
			continue;
		}

		repaired.push(item);

		if (
			(item.type === "function_call" || item.type === "custom_tool_call") &&
			callId !== undefined &&
			!outputCallIds.has(callId)
		) {
			repaired.push({
				type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
				call_id: callId,
				output: ORPHAN_TOOL_CALL_PLACEHOLDER,
			} as InputItem);
		}
	}
	return repaired;
}

function stripImageDetails(input: unknown[]): void {
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const content = "content" in item ? item.content : undefined;
		const output = "output" in item ? item.output : undefined;
		for (const collection of [content, output]) {
			if (!Array.isArray(collection)) continue;
			for (const part of collection) {
				if (!part || typeof part !== "object") continue;
				if (!("type" in part) || part.type !== "input_image") continue;
				if ("detail" in part) part.detail = undefined;
			}
		}
	}
}

export interface CodexLiteShapedBody {
	instructions?: unknown;
	tools?: unknown;
	input?: unknown;
	parallel_tool_calls?: unknown;
}

export function applyCodexResponsesLiteShape(body: CodexLiteShapedBody): void {
	const input = Array.isArray(body.input) ? body.input : [];
	stripImageDetails(input);
	body.parallel_tool_calls = false;
	const prefix: InputItem[] = [
		{ type: "additional_tools", role: "developer", tools: Array.isArray(body.tools) ? body.tools : [] },
	];
	if (typeof body.instructions === "string" && body.instructions.length > 0) {
		prefix.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: body.instructions }],
		});
	}
	body.input = prefix.concat(input);
	delete body.instructions;
	delete body.tools;
}

export async function transformRequestBody(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	options: CodexRequestOptions = {},
	prompt?: { developerMessages: string[] },
): Promise<RequestBody> {
	body.store = false;
	body.stream = true;

	if (body.input && Array.isArray(body.input)) {
		body.input = filterInput(body.input);
		if (body.input) {
			body.input = repairToolCallPairs(body.input);
		}
	}

	if (prompt?.developerMessages && prompt.developerMessages.length > 0) {
		const developerMessages: InputItem[] = prompt.developerMessages.map(text => ({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text }],
		}));
		const input = Array.isArray(body.input) ? body.input : [];
		body.input = developerMessages.concat(input);
	}

	let finalInstruction = prompt?.developerMessages.findLast(text => text.trim().length > 0);
	if (finalInstruction === undefined && Array.isArray(body.input)) {
		for (let itemIndex = body.input.length - 1; itemIndex >= 0; itemIndex -= 1) {
			const item = body.input[itemIndex];
			if (item.role !== "developer" || !Array.isArray(item.content)) continue;
			for (let partIndex = item.content.length - 1; partIndex >= 0; partIndex -= 1) {
				const part = item.content[partIndex];
				if (
					part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "input_text" &&
					"text" in part &&
					typeof part.text === "string" &&
					part.text.trim().length > 0
				) {
					finalInstruction = part.text;
					break;
				}
			}
			if (finalInstruction !== undefined) break;
		}
	}
	if (finalInstruction === undefined && typeof body.instructions === "string" && body.instructions.trim().length > 0) {
		finalInstruction = body.instructions;
	}
	if (finalInstruction !== undefined) {
		const input = Array.isArray(body.input) ? body.input : [];
		let hasVisibleInput = false;
		for (const item of input) {
			if (item.role !== "developer") {
				hasVisibleInput = true;
				break;
			}
		}
		if (!hasVisibleInput) {
			body.input = [
				...input,
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: finalInstruction }],
				},
			];
		}
	}

	const responsesLite = resolveCodexResponsesLite(model, options.responsesLite);
	if (responsesLite) {
		applyCodexResponsesLiteShape(body);
	}

	if (options.reasoningEffort !== undefined || responsesLite) {
		const reasoningConfig =
			options.reasoningEffort !== undefined ? getReasoningConfig(model, options.reasoningEffort, options) : {};
		body.reasoning = {
			...body.reasoning,
			...reasoningConfig,
		};
		const context = responsesLite ? "all_turns" : (options.reasoningContext ?? "all_turns");
		if (context === "all_turns" && !acceptsAllTurnsReasoningContext(model)) {
			delete body.reasoning.context;
		} else {
			body.reasoning.context = context;
		}
	} else {
		delete body.reasoning;
	}
	if (model.reasoningMode) {
		body.reasoning = { ...body.reasoning, mode: model.reasoningMode };
	}

	if (body.reasoning?.summary !== undefined) {
		body.stream_options = { reasoning_summary_delivery: "sequential_cutoff" };
	} else {
		delete body.stream_options;
	}

	body.text = {
		...body.text,
		verbosity: options.textVerbosity || "medium",
	};

	const include = Array.isArray(options.include) ? options.include.slice() : [];
	include.push("reasoning.encrypted_content");
	body.include = Array.from(new Set(include));

	delete body.max_output_tokens;
	delete body.max_completion_tokens;

	return body;
}
