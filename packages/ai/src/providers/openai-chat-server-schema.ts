import { type } from "arktype";
import type {
	ChatCompletionContentPart,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from "./openai-chat-wire";

export const textPartSchema = type({
	type: "'text'",
	text: "string",
});

export const imagePartSchema = type({
	type: "'image_url'",
	image_url: type("string").or({
		url: "string",
		"detail?": "'auto' | 'low' | 'high'",
	}),
});

export const inputAudioPartSchema = type({
	type: "'input_audio'",
	input_audio: {
		data: "string",
		format: "'wav' | 'mp3'",
	},
});

export const filePartSchema = type({
	type: "'file'",
	file: {
		"file_id?": "string",
		"filename?": "string",
		"file_data?": "string",
	},
});

export const refusalPartSchema = type({
	type: "'refusal'",
	refusal: "string",
});

export const unknownPartSchema = type({ type: "string" });

export const userContentPartSchema = textPartSchema
	.or(imagePartSchema)
	.or(inputAudioPartSchema)
	.or(filePartSchema)
	.or(refusalPartSchema)
	.or(unknownPartSchema);

export const toolCallSchema = type({
	id: "string",
	"type?": "'function'",
	function: {
		name: "string",
		arguments: "string",
	},
});

export const toolSchema = type({
	type: "'function'",
	function: {
		name: "string >= 1",
		"description?": "string",
		"parameters?": type({ "[string]": "unknown" }),
		"strict?": "boolean",
	},
});

export const toolChoiceSchema = type("'auto' | 'none' | 'required'")
	.or({
		type: "'function'",
		function: { name: "string >= 1" },
	})
	.or({
		type: "'tool'",
		name: "string >= 1",
	});

const baseContent = type("string").or(userContentPartSchema.array());
const assistantContent = baseContent.or("null");

export const systemMessageSchema = type({
	role: "'system'",
	content: baseContent,
});

export const developerMessageSchema = type({
	role: "'developer'",
	content: baseContent,
});

export const userMessageSchema = type({
	role: "'user'",
	content: baseContent,
});

export const assistantMessageSchema = type({
	role: "'assistant'",
	"content?": assistantContent,
	"tool_calls?": toolCallSchema.array(),
	"reasoning_content?": "string | null",
});

export const toolMessageSchema = type({
	role: "'tool'",
	"content?": baseContent,
	"tool_call_id?": "string",
	"name?": type("string").pipe(v => (v && v.length > 0 ? v : undefined)),
});

export const functionMessageSchema = type({
	role: "'function'",
	name: "string",
	content: "string | null",
});

export const messageSchema = systemMessageSchema
	.or(developerMessageSchema)
	.or(userMessageSchema)
	.or(assistantMessageSchema)
	.or(toolMessageSchema)
	.or(functionMessageSchema);

export const streamOptionsSchema = type({
	"+": "delete",
	"include_usage?": "boolean",
});

export const stopSchema = type("string").or("string[] <= 4");

export const openaiChatRequestSchema = type({
	model: "string >= 1",
	messages: messageSchema.array(),
	"tools?": toolSchema.array(),
	"tool_choice?": toolChoiceSchema,
	"max_tokens?": "number",
	"max_completion_tokens?": "number",
	"temperature?": "number",
	"top_p?": "number",
	"stop?": stopSchema,
	"stream?": "boolean",
	"stream_options?": streamOptionsSchema,

	"response_format?": "unknown",
	"seed?": "number",
	"presence_penalty?": "number",
	"frequency_penalty?": "number",
	"logit_bias?": type({ "[string]": "number" }),
	"user?": "string",
	"reasoning_effort?": "'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'",
	"parallel_tool_calls?": "boolean",
	"service_tier?": "'auto' | 'default' | 'flex' | 'scale' | 'priority'",
	"metadata?": type({ "[string]": "unknown" }),

	"logprobs?": "unknown",
	"top_logprobs?": "unknown",
	"prediction?": "unknown",
	"modalities?": "unknown",
	"audio?": "unknown",
	"store?": "unknown",
	"prompt_cache_key?": "unknown",
	"safety_identifier?": "unknown",
	"n?": "unknown",
	"web_search_options?": "unknown",
});

export type OpenAIChatMessage = ChatCompletionMessageParam;
export type OpenAIChatToolCall = ChatCompletionMessageToolCall;
export type OpenAIChatTool = ChatCompletionTool;
export type OpenAIChatToolChoice = ChatCompletionToolChoiceOption;
export type OpenAIChatContentPart = ChatCompletionContentPart;
