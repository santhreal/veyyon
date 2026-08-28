import { type } from "arktype";
import type {
	ContentBlockParam,
	ImageBlockParam,
	MessageCreateParams,
	MessageParam,
	TextBlockParam,
	Tool,
	ToolChoice,
} from "./anthropic-wire";

export const cacheControlSchema = type({
	type: "'ephemeral'",
	"ttl?": "'1h' | '5m'",
});

export const base64ImageSourceSchema = type({
	type: "'base64'",
	data: "string >= 1",
	media_type: "string >= 1",
});

export const urlImageSourceSchema = type({
	type: "'url'",
	url: "string.url",
});

export const fileImageSourceSchema = type({
	type: "'file'",
	file_id: "string >= 1",
});

export const imageSourceSchema = base64ImageSourceSchema.or(urlImageSourceSchema).or(fileImageSourceSchema);

const textBlockSchema = type({
	type: "'text'",
	text: "string",
	"cache_control?": cacheControlSchema,
});

const imageBlockSchema = type({
	type: "'image'",
	source: imageSourceSchema,
	"cache_control?": cacheControlSchema,
});

const thinkingBlockSchema = type({
	type: "'thinking'",
	thinking: "string",
	"signature?": "string",
	"cache_control?": cacheControlSchema,
});

const redactedThinkingBlockSchema = type({
	type: "'redacted_thinking'",
	data: "string",
	"cache_control?": cacheControlSchema,
});

const toolUseBlockSchema = type({
	type: "'tool_use'",
	id: "string >= 1",
	name: "string >= 1",
	"input?": { "[string]": "unknown" },
	"cache_control?": cacheControlSchema,
});

const toolResultContentBlockSchema = textBlockSchema.or(imageBlockSchema);

const toolResultBlockSchema = type({
	type: "'tool_result'",
	tool_use_id: "string >= 1",
	"content?": type("string").or(toolResultContentBlockSchema.array()),
	"is_error?": "boolean",
	"cache_control?": cacheControlSchema,
});

function unknownContentBlockSchema(knownTypes: readonly string[]) {
	const known = new Set(knownTypes);
	return type({
		type: "string",
	}).narrow((d, ctx) => {
		if (known.has(d.type)) {
			return ctx.mustBe(`an unknown block type (not ${knownTypes.join(", ")})`);
		}
		return true;
	});
}

const systemBlockSchema = type({
	type: "'text'",
	text: "string",
	"cache_control?": cacheControlSchema,
});

export const systemSchema = type("string").or(systemBlockSchema.array()).or("undefined");

const userContentBlockSchema = textBlockSchema
	.or(imageBlockSchema)
	.or(toolResultBlockSchema)
	.or(unknownContentBlockSchema(["text", "image", "tool_result"]));

const assistantContentBlockSchema = textBlockSchema
	.or(thinkingBlockSchema)
	.or(redactedThinkingBlockSchema)
	.or(toolUseBlockSchema)
	.or(unknownContentBlockSchema(["text", "thinking", "redacted_thinking", "tool_use"]));

export const userMessageSchema = type({
	role: "'user'",
	content: type("string").or(userContentBlockSchema.array()),
});

export const systemMessageSchema = type({
	role: "'system'",
	content: type("string").or(systemBlockSchema.array()),
});

export const assistantMessageSchema = type({
	role: "'assistant'",
	content: type("string").or(assistantContentBlockSchema.array()),
});

export const messageSchema = userMessageSchema.or(assistantMessageSchema).or(systemMessageSchema);

export const toolSchema = type({
	name: "string >= 1",
	"description?": "string",
	input_schema: { "[string]": "unknown" },
	"cache_control?": cacheControlSchema,
});

export const toolChoiceSchema = type({
	type: "'auto'",
	"disable_parallel_tool_use?": "boolean",
})
	.or({
		type: "'any'",
		"disable_parallel_tool_use?": "boolean",
	})
	.or({
		type: "'none'",
		"disable_parallel_tool_use?": "boolean",
	})
	.or({
		type: "'tool'",
		name: "string >= 1",
		"disable_parallel_tool_use?": "boolean",
	});

export const thinkingConfigSchema = type({
	type: "'enabled'",
	budget_tokens: "number",
	"display?": "unknown",
})
	.or({
		type: "'disabled'",
		"display?": "unknown",
	})
	.or({
		type: "'adaptive'",
		"budget_tokens?": "number",
		"display?": "unknown",
	});

const taskBudgetSchema = type({
	type: "'tokens'",
	total: "number",
	"remaining?": "number",
});

const outputConfigSchema = type({
	"effort?": "'low' | 'medium' | 'high' | 'xhigh' | 'max'",
	"task_budget?": taskBudgetSchema,
	"format?": "unknown",
});

export const anthropicMessagesRequestSchema = type({
	model: "string >= 1",
	messages: messageSchema.array(),
	max_tokens: "number",
	"system?": systemSchema,
	"tools?": toolSchema.array(),
	"tool_choice?": toolChoiceSchema,
	"temperature?": "number",
	"top_p?": "number",
	"top_k?": "number",
	"stop_sequences?": "string[]",
	"stream?": "boolean",
	"thinking?": thinkingConfigSchema,
	"output_config?": outputConfigSchema,
	"metadata?": { "[string]": "unknown" },
	"container?": "unknown",
	"context_management?": "unknown",
	"mcp_servers?": "unknown",
	"service_tier?": "unknown",
});

export type AnthropicMessagesRequest = MessageCreateParams;
export type AnthropicSystem = MessageCreateParams["system"];
export type AnthropicMessage = MessageParam;
export type AnthropicUserContentBlock = ContentBlockParam;
export type AnthropicAssistantContentBlock = ContentBlockParam;
export type AnthropicTool = Tool;
export type AnthropicToolChoice = ToolChoice;
export type AnthropicToolResultContent = TextBlockParam | ImageBlockParam;
