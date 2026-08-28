import { emptyUsage } from "@veyyon/catalog/models";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamOptions,
	TextContent,
	Tool,
	ToolChoice,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { kStreamingPartialJson } from "../utils/block-symbols";
import { sanitizeSchemaForOllama, toolWireSchema } from "../utils/schema";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, partitionVisionContent } from "./vision-guard";

export { streamOllama } from "./ollama-helpers";

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

type OllamaChatChunk = {
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		tool_calls?: Array<{
			type?: string;
			function?: {
				index?: number;
				name?: string;
				arguments?: Record<string, unknown> | string;
			};
		}>;
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
};

export type InternalToolCallBlock = AssistantMessage["content"][number] & {
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
		const developerRole =
			msg.role === "developer" && (index < systemPrompts.length || msg.attribution !== "user") ? "system" : "user";
		const converted = convertMessage(msg, supportsImages, developerRole);
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

const OLLAMA_CLOUD_NUM_PREDICT_CAP = 65_536;

function resolveNumPredict(model: Model<"ollama-chat">, requested: number): number {
	if (model.provider === "ollama-cloud") {
		return Math.min(requested, OLLAMA_CLOUD_NUM_PREDICT_CAP);
	}
	return requested;
}

export function createChatBody(model: Model<"ollama-chat">, context: Context, options: OllamaChatOptions | undefined) {
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

export const OLLAMA_RESPONSE_RETRY_POLICY: AIError.ResponseRetryPolicy = {
	api: "ollama-chat",
	refusesReplay: body => AIError.LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(body),
};

export async function* iterateNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChatChunk> {
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

export function createEmptyOutput(model: Model<"ollama-chat">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "ollama-chat" as Api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
