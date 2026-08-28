export type ChatModel =
	| "gpt-5.4"
	| "gpt-5.4-mini"
	| "gpt-5.4-nano"
	| "gpt-5.4-mini-2026-03-17"
	| "gpt-5.4-nano-2026-03-17"
	| "gpt-5.3-chat-latest"
	| "gpt-5.2"
	| "gpt-5.2-2025-12-11"
	| "gpt-5.2-chat-latest"
	| "gpt-5.2-pro"
	| "gpt-5.2-pro-2025-12-11"
	| "gpt-5.1"
	| "gpt-5.1-2025-11-13"
	| "gpt-5.1-codex"
	| "gpt-5.1-mini"
	| "gpt-5.1-chat-latest"
	| "gpt-5"
	| "gpt-5-mini"
	| "gpt-5-nano"
	| "gpt-5-2025-08-07"
	| "gpt-5-mini-2025-08-07"
	| "gpt-5-nano-2025-08-07"
	| "gpt-5-chat-latest"
	| "gpt-4.1"
	| "gpt-4.1-mini"
	| "gpt-4.1-nano"
	| "gpt-4.1-2025-04-14"
	| "gpt-4.1-mini-2025-04-14"
	| "gpt-4.1-nano-2025-04-14"
	| "o4-mini"
	| "o4-mini-2025-04-16"
	| "o3"
	| "o3-2025-04-16"
	| "o3-mini"
	| "o3-mini-2025-01-31"
	| "o1"
	| "o1-2024-12-17"
	| "o1-preview"
	| "o1-preview-2024-09-12"
	| "o1-mini"
	| "o1-mini-2024-09-12"
	| "gpt-4o"
	| "gpt-4o-2024-11-20"
	| "gpt-4o-2024-08-06"
	| "gpt-4o-2024-05-13"
	| "gpt-4o-audio-preview"
	| "gpt-4o-audio-preview-2024-10-01"
	| "gpt-4o-audio-preview-2024-12-17"
	| "gpt-4o-audio-preview-2025-06-03"
	| "gpt-4o-mini-audio-preview"
	| "gpt-4o-mini-audio-preview-2024-12-17"
	| "gpt-4o-search-preview"
	| "gpt-4o-mini-search-preview"
	| "gpt-4o-search-preview-2025-03-11"
	| "gpt-4o-mini-search-preview-2025-03-11"
	| "chatgpt-4o-latest"
	| "codex-mini-latest"
	| "gpt-4o-mini"
	| "gpt-4o-mini-2024-07-18"
	| "gpt-4-turbo"
	| "gpt-4-turbo-2024-04-09"
	| "gpt-4-0125-preview"
	| "gpt-4-turbo-preview"
	| "gpt-4-1106-preview"
	| "gpt-4-vision-preview"
	| "gpt-4"
	| "gpt-4-0314"
	| "gpt-4-0613"
	| "gpt-4-32k"
	| "gpt-4-32k-0314"
	| "gpt-4-32k-0613"
	| "gpt-3.5-turbo"
	| "gpt-3.5-turbo-16k"
	| "gpt-3.5-turbo-0301"
	| "gpt-3.5-turbo-0613"
	| "gpt-3.5-turbo-1106"
	| "gpt-3.5-turbo-0125"
	| "gpt-3.5-turbo-16k-0613";

export interface FunctionDefinition {
	name: string;
	description?: string;
	parameters?: FunctionParameters;
	strict?: boolean | null;
}

export type FunctionParameters = {
	[key: string]: unknown;
};

export type Metadata = {
	[key: string]: string;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;

export interface ResponseFormatJSONObject {
	type: "json_object";
}

export interface ResponseFormatJSONSchema {
	json_schema: ResponseFormatJSONSchemaJSONSchema;
	type: "json_schema";
}

export interface ResponseFormatJSONSchemaJSONSchema {
	name: string;
	description?: string;
	schema?: {
		[key: string]: unknown;
	};
	strict?: boolean | null;
}

export interface ResponseFormatText {
	type: "text";
}

export interface CompletionUsage {
	completion_tokens: number;
	prompt_tokens: number;
	total_tokens: number;
	completion_tokens_details?: CompletionUsageCompletionTokensDetails;
	prompt_tokens_details?: CompletionUsagePromptTokensDetails;
}

export interface CompletionUsageCompletionTokensDetails {
	accepted_prediction_tokens?: number;
	audio_tokens?: number;
	reasoning_tokens?: number;
	rejected_prediction_tokens?: number;
}

export interface CompletionUsagePromptTokensDetails {
	audio_tokens?: number;
	cached_tokens?: number;
}

export interface ChatCompletionContentPartText {
	text: string;
	type: "text";
}

export interface ChatCompletionContentPartImage {
	image_url: ChatCompletionContentPartImageImageURL;
	type: "image_url";
}

export interface ChatCompletionContentPartImageImageURL {
	url: string;
	detail?: "auto" | "low" | "high";
}

export interface ChatCompletionContentPartInputAudio {
	input_audio: ChatCompletionContentPartInputAudioInputAudio;
	type: "input_audio";
}

export interface ChatCompletionContentPartInputAudioInputAudio {
	data: string;
	format: "wav" | "mp3";
}

export interface ChatCompletionContentPartFile {
	file: ChatCompletionContentPartFileFile;
	type: "file";
}

export interface ChatCompletionContentPartFileFile {
	file_data?: string;
	file_id?: string;
	filename?: string;
}

export interface ChatCompletionContentPartRefusal {
	refusal: string;
	type: "refusal";
}

export type ChatCompletionContentPart =
	| ChatCompletionContentPartText
	| ChatCompletionContentPartImage
	| ChatCompletionContentPartInputAudio
	| ChatCompletionContentPartFile;

export interface ChatCompletionMessageFunctionToolCall {
	id: string;
	function: ChatCompletionMessageFunctionToolCallFunction;
	type: "function";
}

export interface ChatCompletionMessageFunctionToolCallFunction {
	arguments: string;
	name: string;
}

export interface ChatCompletionMessageCustomToolCall {
	id: string;
	custom: ChatCompletionMessageCustomToolCallCustom;
	type: "custom";
}

export interface ChatCompletionMessageCustomToolCallCustom {
	input: string;
	name: string;
}

export type ChatCompletionMessageToolCall = ChatCompletionMessageFunctionToolCall | ChatCompletionMessageCustomToolCall;

export interface ChatCompletionDeveloperMessageParam {
	content: string | Array<ChatCompletionContentPartText>;
	role: "developer";
	name?: string;
}

export interface ChatCompletionSystemMessageParam {
	content: string | Array<ChatCompletionContentPartText>;
	role: "system";
	name?: string;
}

export interface ChatCompletionUserMessageParam {
	content: string | Array<ChatCompletionContentPart>;
	role: "user";
	name?: string;
}

export interface ChatCompletionAssistantMessageParam {
	role: "assistant";
	audio?: ChatCompletionAssistantMessageParamAudio | null;
	content?: string | Array<ChatCompletionContentPartText | ChatCompletionContentPartRefusal> | null;
	function_call?: ChatCompletionAssistantMessageParamFunctionCall | null;
	name?: string;
	refusal?: string | null;
	tool_calls?: Array<ChatCompletionMessageToolCall>;
}

export interface ChatCompletionAssistantMessageParamAudio {
	id: string;
}

export interface ChatCompletionAssistantMessageParamFunctionCall {
	arguments: string;
	name: string;
}

export interface ChatCompletionToolMessageParam {
	content: string | Array<ChatCompletionContentPartText>;
	role: "tool";
	tool_call_id: string;
}

export interface ChatCompletionFunctionMessageParam {
	content: string | null;
	name: string;
	role: "function";
}

export type ChatCompletionMessageParam =
	| ChatCompletionDeveloperMessageParam
	| ChatCompletionSystemMessageParam
	| ChatCompletionUserMessageParam
	| ChatCompletionAssistantMessageParam
	| ChatCompletionToolMessageParam
	| ChatCompletionFunctionMessageParam;

export interface ChatCompletionFunctionTool {
	function: FunctionDefinition;
	type: "function";
}

export interface ChatCompletionCustomTool {
	custom: ChatCompletionCustomToolCustom;
	type: "custom";
}

export interface ChatCompletionCustomToolCustom {
	name: string;
	description?: string;
	format?: ChatCompletionCustomToolCustomText | ChatCompletionCustomToolCustomGrammar;
}

export interface ChatCompletionCustomToolCustomText {
	type: "text";
}

export interface ChatCompletionCustomToolCustomGrammar {
	grammar: ChatCompletionCustomToolCustomGrammarGrammar;
	type: "grammar";
}

export interface ChatCompletionCustomToolCustomGrammarGrammar {
	definition: string;
	syntax: "lark" | "regex";
}

export type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool;

export interface ChatCompletionAllowedTools {
	mode: "auto" | "required";
	tools: Array<{
		[key: string]: unknown;
	}>;
}

export interface ChatCompletionAllowedToolChoice {
	allowed_tools: ChatCompletionAllowedTools;
	type: "allowed_tools";
}

export interface ChatCompletionNamedToolChoice {
	function: ChatCompletionNamedToolChoiceFunction;
	type: "function";
}

export interface ChatCompletionNamedToolChoiceFunction {
	name: string;
}

export interface ChatCompletionNamedToolChoiceCustom {
	custom: ChatCompletionNamedToolChoiceCustomCustom;
	type: "custom";
}

export interface ChatCompletionNamedToolChoiceCustomCustom {
	name: string;
}

export type ChatCompletionToolChoiceOption =
	| "none"
	| "auto"
	| "required"
	| ChatCompletionAllowedToolChoice
	| ChatCompletionNamedToolChoice
	| ChatCompletionNamedToolChoiceCustom;

export interface ChatCompletionTokenLogprob {
	token: string;
	bytes: Array<number> | null;
	logprob: number;
	top_logprobs: Array<ChatCompletionTokenLogprobTopLogprob>;
}

export interface ChatCompletionTokenLogprobTopLogprob {
	token: string;
	bytes: Array<number> | null;
	logprob: number;
}

export interface ChatCompletionChunk {
	id: string;
	choices: Array<ChatCompletionChunkChoice>;
	created: number;
	model: string;
	object: "chat.completion.chunk";
	moderation?: ChatCompletionChunkModeration | null;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	system_fingerprint?: string;
	usage?: CompletionUsage | null;
}

export declare namespace ChatCompletionChunk {
	export type Choice = ChatCompletionChunkChoice;
	export type Moderation = ChatCompletionChunkModeration;
}

export interface ChatCompletionChunkChoice {
	delta: ChatCompletionChunkChoiceDelta;
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
	index: number;
	logprobs?: ChatCompletionChunkChoiceLogprobs | null;
}

export interface ChatCompletionChunkChoiceDelta {
	content?: string | null;
	function_call?: ChatCompletionChunkChoiceDeltaFunctionCall;
	refusal?: string | null;
	role?: "developer" | "system" | "user" | "assistant" | "tool";
	tool_calls?: Array<ChatCompletionChunkChoiceDeltaToolCall>;
}

export interface ChatCompletionChunkChoiceDeltaFunctionCall {
	arguments?: string;
	name?: string;
}

export interface ChatCompletionChunkChoiceDeltaToolCall {
	index: number;
	id?: string;
	function?: ChatCompletionChunkChoiceDeltaToolCallFunction;
	type?: "function";
}

export interface ChatCompletionChunkChoiceDeltaToolCallFunction {
	arguments?: string;
	name?: string;
}

export interface ChatCompletionChunkChoiceLogprobs {
	content: Array<ChatCompletionTokenLogprob> | null;
	refusal: Array<ChatCompletionTokenLogprob> | null;
}

export interface ChatCompletionChunkModeration {
	input: ChatCompletionChunkModerationResults | ChatCompletionChunkModerationError;
	output: ChatCompletionChunkModerationResults | ChatCompletionChunkModerationError;
}

export interface ChatCompletionChunkModerationResults {
	model: string;
	results: Array<ChatCompletionChunkModerationResult>;
	type: "moderation_results";
}

export interface ChatCompletionChunkModerationResult {
	categories: {
		[key: string]: boolean;
	};
	category_applied_input_types: {
		[key: string]: Array<"text" | "image">;
	};
	category_scores: {
		[key: string]: number;
	};
	flagged: boolean;
	model: string;
	type: "moderation_result";
}

export interface ChatCompletionChunkModerationError {
	code: string;
	message: string;
	type: "error";
}

export interface ChatCompletionAudioParam {
	format: "wav" | "aac" | "mp3" | "flac" | "opus" | "pcm16";
	voice:
		| string
		| "alloy"
		| "ash"
		| "ballad"
		| "coral"
		| "echo"
		| "sage"
		| "shimmer"
		| "verse"
		| "marin"
		| "cedar"
		| ChatCompletionAudioParamID;
}

export interface ChatCompletionAudioParamID {
	id: string;
}

export interface ChatCompletionFunctionCallOption {
	name: string;
}

export interface ChatCompletionPredictionContent {
	content: string | Array<ChatCompletionContentPartText>;
	type: "content";
}

export interface ChatCompletionStreamOptions {
	include_obfuscation?: boolean;
	include_usage?: boolean;
}

export interface ChatCompletionCreateParamsFunction {
	name: string;
	description?: string;
	parameters?: FunctionParameters;
}

export interface ChatCompletionCreateParamsModeration {
	model: string;
}

export interface ChatCompletionCreateParamsWebSearchOptions {
	search_context_size?: "low" | "medium" | "high";
	user_location?: ChatCompletionCreateParamsWebSearchOptionsUserLocation | null;
}

export interface ChatCompletionCreateParamsWebSearchOptionsUserLocation {
	approximate: ChatCompletionCreateParamsWebSearchOptionsUserLocationApproximate;
	type: "approximate";
}

export interface ChatCompletionCreateParamsWebSearchOptionsUserLocationApproximate {
	city?: string;
	country?: string;
	region?: string;
	timezone?: string;
}

export interface ChatCompletionCreateParamsBase {
	messages: Array<ChatCompletionMessageParam>;
	model: (string & {}) | ChatModel;
	audio?: ChatCompletionAudioParam | null;
	frequency_penalty?: number | null;
	function_call?: "none" | "auto" | ChatCompletionFunctionCallOption;
	functions?: Array<ChatCompletionCreateParamsFunction>;
	logit_bias?: {
		[key: string]: number;
	} | null;
	logprobs?: boolean | null;
	max_completion_tokens?: number | null;
	max_tokens?: number | null;
	metadata?: Metadata | null;
	modalities?: Array<"text" | "audio"> | null;
	moderation?: ChatCompletionCreateParamsModeration | null;
	n?: number | null;
	parallel_tool_calls?: boolean;
	prediction?: ChatCompletionPredictionContent | null;
	presence_penalty?: number | null;
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h" | null;
	reasoning_effort?: ReasoningEffort | null;
	response_format?: ResponseFormatText | ResponseFormatJSONSchema | ResponseFormatJSONObject;
	safety_identifier?: string;
	seed?: number | null;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	stop?: string | null | Array<string>;
	store?: boolean | null;
	stream?: boolean | null;
	stream_options?: ChatCompletionStreamOptions | null;
	temperature?: number | null;
	tool_choice?: ChatCompletionToolChoiceOption;
	tools?: Array<ChatCompletionTool>;
	top_logprobs?: number | null;
	top_p?: number | null;
	user?: string;
	verbosity?: "low" | "medium" | "high" | null;
	web_search_options?: ChatCompletionCreateParamsWebSearchOptions;
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
	stream?: false | null;
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
	stream: true;
}
