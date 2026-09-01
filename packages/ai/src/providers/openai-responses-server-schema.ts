import { type } from "arktype";
import type {
	ResponseCreateParams,
	ResponseFunctionToolCall,
	ResponseInputContent,
	ResponseInputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	Tool as ResponsesTool,
} from "./openai-responses-wire";

const inputTextSchema = type({
	type: "'input_text'",
	text: "string",
});

const plainTextSchema = type({
	type: "'text'",
	text: "string",
});

const inputImageBlockSchema = type({
	type: "'input_image'",
	"detail?": "'auto' | 'low' | 'high'",
	"image_url?": "string",
	"file_id?": "string",
}).narrow((v, ctx) => {
	return (
		typeof v.image_url === "string" ||
		typeof v.file_id === "string" ||
		ctx.mustBe("at least one of `image_url` or `file_id` for input_image")
	);
});

const inputFileBlockSchema = type({
	type: "'input_file'",
	"file_id?": "string",
	"filename?": "string",
	"file_data?": "string",
});

const outputTextSchema = type({
	type: "'output_text'",
	text: "string",
});

const outputRefusalSchema = type({
	type: "'refusal'",
	refusal: "string",
});

const summaryTextSchema = type({
	type: "'summary_text'",
	text: "string",
});

const reasoningTextSchema = type({
	type: "'reasoning_text'",
	text: "string",
});

const inputContentBlockSchema = inputTextSchema.or(plainTextSchema).or(inputImageBlockSchema).or(inputFileBlockSchema);

const outputContentBlockSchema = outputTextSchema.or(plainTextSchema).or(outputRefusalSchema);

const userMessageItemSchema = type({
	"type?": "'message'",
	role: "'user' | 'developer'",
	"content?": type("string").or(inputContentBlockSchema.array()),
});

const systemMessageItemSchema = type({
	"type?": "'message'",
	role: "'system'",
	"content?": type("string").or(inputContentBlockSchema.array()),
});

const assistantMessageItemSchema = type({
	"type?": "'message'",
	"id?": "string",
	role: "'assistant'",
	"content?": type("string").or(outputContentBlockSchema.array()),
	"status?": "'in_progress' | 'completed' | 'incomplete'",
	"phase?": "'commentary' | 'final_answer' | null",
});

const reasoningItemSchema = type({
	type: "'reasoning'",
	"id?": "string",
	"summary?": summaryTextSchema.array(),
	"content?": reasoningTextSchema.array(),
});

const functionCallItemSchema = type({
	type: "'function_call'",
	"id?": "string",
	call_id: "string >= 1",
	name: "string >= 1",
	"arguments?": "string",
});

const functionCallOutputItemSchema = type({
	type: "'function_call_output'",
	call_id: "string >= 1",
	"output?": type("string").or(outputContentBlockSchema.array()),
});

const customToolCallItemSchema = type({
	type: "'custom_tool_call'",
	"id?": "string",
	call_id: "string >= 1",
	name: "string >= 1",
	input: "string",
});

const customToolCallOutputItemSchema = type({
	type: "'custom_tool_call_output'",
	call_id: "string >= 1",
	output: "string",
});

export const inputItemSchema = userMessageItemSchema
	.or(systemMessageItemSchema)
	.or(assistantMessageItemSchema)
	.or(reasoningItemSchema)
	.or(functionCallItemSchema)
	.or(functionCallOutputItemSchema)
	.or(customToolCallItemSchema)
	.or(customToolCallOutputItemSchema)
	.or(type({ type: "string" }));

export type OpenAIResponsesReasoningItem = ResponseReasoningItem;
export type OpenAIResponsesFunctionCallItem = ResponseFunctionToolCall;
export type OpenAIResponsesFunctionCallOutputItem = ResponseInputItem.FunctionCallOutput;

export const toolSchema = type({
	type: "'function'",
	name: "string >= 1",
	"description?": "string",
	"parameters?": type({ "[string]": "unknown" }),
	"strict?": "boolean",
});

const builtinToolSchema = type({
	type: "string",
});

const hostedToolType = type(
	"'web_search_preview' | 'file_search' | 'computer_use_preview' | 'code_interpreter' | 'image_generation' | 'mcp'",
);

const allowedToolEntrySchema = type({
	type: "string",
	"name?": "string",
});

export const toolChoiceSchema = type("'auto' | 'none' | 'required'")
	.or(
		type({
			type: "'function'",
			name: "string >= 1",
		}),
	)
	.or(
		type({
			type: "'custom'",
			name: "string >= 1",
		}),
	)
	.or(
		type({
			type: hostedToolType,
		}),
	)
	.or(
		type({
			type: "'allowed_tools'",
			mode: "'auto' | 'required'",
			tools: allowedToolEntrySchema.array(),
		}),
	);

export const reasoningConfigSchema = type({
	"effort?": "string",
	"summary?": "'auto' | 'concise' | 'detailed' | 'none'",
});

export const stopSchema = type("string | string[] | null");

export const openaiResponsesRequestSchema = type({
	model: "string >= 1",
	"input?": type("string").or(inputItemSchema.array()),
	"instructions?": "string | null",
	"tools?": toolSchema.or(builtinToolSchema).array(),
	"tool_choice?": toolChoiceSchema,
	"max_output_tokens?": "number",
	"temperature?": "number",
	"top_p?": "number",
	"stop?": stopSchema,
	"stream?": "boolean",
	"reasoning?": reasoningConfigSchema,
	"store?": "boolean",
	"previous_response_id?": "string",
	"parallel_tool_calls?": "boolean",
	"prompt_cache_key?": "string",
	"metadata?": "unknown",
	"user?": "string",
	"service_tier?": "string",
	"presence_penalty?": "number",
	"frequency_penalty?": "number",
	"background?": "unknown",
	"include?": "unknown",
	"prompt?": "unknown",
	"safety_identifier?": "unknown",
	"text?": "unknown",
	"top_logprobs?": "unknown",
	"truncation?": "unknown",
});

export type OpenAIResponsesTool = ResponsesTool;
export type OpenAIResponsesToolChoice = NonNullable<ResponseCreateParams["tool_choice"]>;
export type OpenAIResponsesInputContent = ResponseInputContent;
export type OpenAIResponsesOutputContent = ResponseOutputMessage["content"][number];
