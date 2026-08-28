export interface ApplyPatchTool {
	type: "apply_patch";
}

export type ComputerAction =
	| ComputerAction.Click
	| ComputerAction.DoubleClick
	| ComputerAction.Drag
	| ComputerAction.Keypress
	| ComputerAction.Move
	| ComputerAction.Screenshot
	| ComputerAction.Scroll
	| ComputerAction.Type
	| ComputerAction.Wait;
export declare namespace ComputerAction {
	interface Click {
		button: "left" | "right" | "wheel" | "back" | "forward";

		type: "click";

		x: number;

		y: number;

		keys?: Array<string> | null;
	}

	interface DoubleClick {
		keys: Array<string> | null;

		type: "double_click";

		x: number;

		y: number;
	}

	interface Drag {
		path: Array<Drag.Path>;

		type: "drag";

		keys?: Array<string> | null;
	}
	namespace Drag {
		interface Path {
			x: number;

			y: number;
		}
	}

	interface Keypress {
		keys: Array<string>;

		type: "keypress";
	}

	interface Move {
		type: "move";

		x: number;

		y: number;

		keys?: Array<string> | null;
	}

	interface Screenshot {
		type: "screenshot";
	}

	interface Scroll {
		scroll_x: number;

		scroll_y: number;

		type: "scroll";

		x: number;

		y: number;

		keys?: Array<string> | null;
	}

	interface Type {
		text: string;

		type: "type";
	}

	interface Wait {
		type: "wait";
	}
}

export type ComputerActionList = Array<ComputerAction>;

export interface ComputerTool {
	type: "computer";
}

export interface ComputerUsePreviewTool {
	display_height: number;

	display_width: number;

	environment: "windows" | "mac" | "linux" | "ubuntu" | "browser";

	type: "computer_use_preview";
}
export interface ContainerAuto {
	type: "container_auto";

	file_ids?: Array<string>;

	memory_limit?: "1g" | "4g" | "16g" | "64g" | null;

	network_policy?: ContainerNetworkPolicyDisabled | ContainerNetworkPolicyAllowlist;

	skills?: Array<SkillReference | InlineSkill>;
}
export interface ContainerNetworkPolicyAllowlist {
	allowed_domains: Array<string>;

	type: "allowlist";

	domain_secrets?: Array<ContainerNetworkPolicyDomainSecret>;
}
export interface ContainerNetworkPolicyDisabled {
	type: "disabled";
}
export interface ContainerNetworkPolicyDomainSecret {
	domain: string;

	name: string;

	value: string;
}
export interface ContainerReference {
	container_id: string;

	type: "container_reference";
}

export interface CustomTool {
	name: string;

	type: "custom";

	defer_loading?: boolean;

	description?: string;

	format?: CustomToolInputFormat;
}

export interface EasyInputMessage {
	content: string | ResponseInputMessageContentList;

	role: "user" | "assistant" | "system" | "developer";

	phase?: "commentary" | "final_answer" | null;

	type?: "message";
}

export interface FileSearchTool {
	type: "file_search";

	vector_store_ids: Array<string>;

	filters?: ComparisonFilter | CompoundFilter | null;

	max_num_results?: number;

	ranking_options?: FileSearchTool.RankingOptions;
}
export declare namespace FileSearchTool {
	interface RankingOptions {
		hybrid_search?: RankingOptions.HybridSearch;

		ranker?: "auto" | "default-2024-11-15";

		score_threshold?: number;
	}
	namespace RankingOptions {
		interface HybridSearch {
			embedding_weight: number;

			text_weight: number;
		}
	}
}

export interface FunctionShellTool {
	type: "shell";
	environment?: ContainerAuto | LocalEnvironment | ContainerReference | null;
}

export interface FunctionTool {
	name: string;

	parameters: {
		[key: string]: unknown;
	} | null;

	strict: boolean | null;

	type: "function";

	defer_loading?: boolean;

	description?: string | null;
}
export interface InlineSkill {
	description: string;

	name: string;

	source: InlineSkillSource;

	type: "inline";
}

export interface InlineSkillSource {
	data: string;

	media_type: "application/zip";

	type: "base64";
}
export interface LocalEnvironment {
	type: "local";

	skills?: Array<LocalSkill>;
}
export interface LocalSkill {
	description: string;

	name: string;

	path: string;
}

export interface NamespaceTool {
	description: string;

	name: string;

	tools: Array<NamespaceTool.Function | CustomTool>;

	type: "namespace";
}
export declare namespace NamespaceTool {
	interface Function {
		name: string;
		type: "function";

		defer_loading?: boolean;
		description?: string | null;
		parameters?: unknown | null;
		strict?: boolean | null;
	}
}
export interface Response {
	id: string;

	created_at: number;
	output_text: string;

	error: ResponseError | null;

	incomplete_details: Response.IncompleteDetails | null;

	instructions: string | Array<ResponseInputItem> | null;

	metadata: Metadata | null;

	model: ResponsesModel;

	object: "response";

	output: Array<ResponseOutputItem>;

	parallel_tool_calls: boolean;

	temperature: number | null;

	tool_choice:
		| ToolChoiceOptions
		| ToolChoiceAllowed
		| ToolChoiceTypes
		| ToolChoiceFunction
		| ToolChoiceMcp
		| ToolChoiceCustom
		| ToolChoiceApplyPatch
		| ToolChoiceShell;

	tools: Array<Tool>;

	top_p: number | null;

	background?: boolean | null;

	completed_at?: number | null;

	conversation?: Response.Conversation | null;

	max_output_tokens?: number | null;

	moderation?: Response.Moderation | null;

	previous_response_id?: string | null;

	prompt?: ResponsePrompt | null;

	prompt_cache_key?: string;

	prompt_cache_retention?: "in_memory" | "24h" | null;

	reasoning?: Reasoning | null;

	safety_identifier?: string;

	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;

	status?: ResponseStatus;

	text?: ResponseTextConfig;

	top_logprobs?: number | null;

	truncation?: "auto" | "disabled" | null;

	usage?: ResponseUsage;

	user?: string;
}
export declare namespace Response {
	interface IncompleteDetails {
		reason?: "max_output_tokens" | "content_filter";
	}

	interface Conversation {
		id: string;
	}

	interface Moderation {
		input: Moderation.ModerationResult | Moderation.Error;

		output: Moderation.ModerationResult | Moderation.Error;
	}
	namespace Moderation {
		interface ModerationResult {
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

		interface Error {
			code: string;

			message: string;

			type: "error";
		}

		interface ModerationResult {
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

		interface Error {
			code: string;

			message: string;

			type: "error";
		}
	}
}

export interface ResponseApplyPatchToolCall {
	id: string;

	call_id: string;

	operation:
		| ResponseApplyPatchToolCall.CreateFile
		| ResponseApplyPatchToolCall.DeleteFile
		| ResponseApplyPatchToolCall.UpdateFile;

	status: "in_progress" | "completed";

	type: "apply_patch_call";

	created_by?: string;
}
export declare namespace ResponseApplyPatchToolCall {
	interface CreateFile {
		diff: string;

		path: string;

		type: "create_file";
	}

	interface DeleteFile {
		path: string;

		type: "delete_file";
	}

	interface UpdateFile {
		diff: string;

		path: string;

		type: "update_file";
	}
}

export interface ResponseApplyPatchToolCallOutput {
	id: string;

	call_id: string;

	status: "completed" | "failed";

	type: "apply_patch_call_output";

	created_by?: string;

	output?: string | null;
}

export interface ResponseAudioDeltaEvent {
	delta: string;

	sequence_number: number;

	type: "response.audio.delta";
}

export interface ResponseAudioDoneEvent {
	sequence_number: number;

	type: "response.audio.done";
}

export interface ResponseAudioTranscriptDeltaEvent {
	delta: string;

	sequence_number: number;

	type: "response.audio.transcript.delta";
}

export interface ResponseAudioTranscriptDoneEvent {
	sequence_number: number;

	type: "response.audio.transcript.done";
}

export interface ResponseCodeInterpreterCallCodeDeltaEvent {
	delta: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.code_interpreter_call_code.delta";
}

export interface ResponseCodeInterpreterCallCodeDoneEvent {
	code: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.code_interpreter_call_code.done";
}

export interface ResponseCodeInterpreterCallCompletedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.code_interpreter_call.completed";
}

export interface ResponseCodeInterpreterCallInProgressEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.code_interpreter_call.in_progress";
}

export interface ResponseCodeInterpreterCallInterpretingEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.code_interpreter_call.interpreting";
}

export interface ResponseCodeInterpreterToolCall {
	id: string;

	code: string | null;

	container_id: string;

	outputs: Array<ResponseCodeInterpreterToolCall.Logs | ResponseCodeInterpreterToolCall.Image> | null;

	status: "in_progress" | "completed" | "incomplete" | "interpreting" | "failed";

	type: "code_interpreter_call";
}
export declare namespace ResponseCodeInterpreterToolCall {
	interface Logs {
		logs: string;

		type: "logs";
	}

	interface Image {
		type: "image";

		url: string;
	}
}

export interface ResponseCompactionItem {
	id: string;

	encrypted_content: string;

	type: "compaction";

	created_by?: string;
}

export interface ResponseCompactionItemParam {
	encrypted_content: string;

	type: "compaction";

	id?: string | null;
}

export interface ResponseCompletedEvent {
	response: Response;

	sequence_number: number;

	type: "response.completed";
}

export interface ResponseComputerToolCall {
	id: string;

	call_id: string;

	pending_safety_checks: Array<ResponseComputerToolCall.PendingSafetyCheck>;

	status: "in_progress" | "completed" | "incomplete";

	type: "computer_call";

	action?:
		| ResponseComputerToolCall.Click
		| ResponseComputerToolCall.DoubleClick
		| ResponseComputerToolCall.Drag
		| ResponseComputerToolCall.Keypress
		| ResponseComputerToolCall.Move
		| ResponseComputerToolCall.Screenshot
		| ResponseComputerToolCall.Scroll
		| ResponseComputerToolCall.Type
		| ResponseComputerToolCall.Wait;

	actions?: ComputerActionList;
}
export declare namespace ResponseComputerToolCall {
	interface PendingSafetyCheck {
		id: string;

		code?: string | null;

		message?: string | null;
	}

	interface Click {
		button: "left" | "right" | "wheel" | "back" | "forward";

		type: "click";

		x: number;

		y: number;

		keys?: Array<string> | null;
	}

	interface DoubleClick {
		keys: Array<string> | null;

		type: "double_click";

		x: number;

		y: number;
	}

	interface Drag {
		path: Array<Drag.Path>;

		type: "drag";

		keys?: Array<string> | null;
	}
	namespace Drag {
		interface Path {
			x: number;

			y: number;
		}
	}

	interface Keypress {
		keys: Array<string>;

		type: "keypress";
	}

	interface Move {
		type: "move";

		x: number;

		y: number;

		keys?: Array<string> | null;
	}

	interface Screenshot {
		type: "screenshot";
	}

	interface Scroll {
		scroll_x: number;

		scroll_y: number;

		type: "scroll";

		x: number;

		y: number;

		keys?: Array<string> | null;
	}

	interface Type {
		text: string;

		type: "type";
	}

	interface Wait {
		type: "wait";
	}
}
export interface ResponseComputerToolCallOutputItem {
	id: string;

	call_id: string;

	output: ResponseComputerToolCallOutputScreenshot;

	status: "completed" | "incomplete" | "failed" | "in_progress";

	type: "computer_call_output";

	acknowledged_safety_checks?: Array<ResponseComputerToolCallOutputItem.AcknowledgedSafetyCheck>;

	created_by?: string;
}
export declare namespace ResponseComputerToolCallOutputItem {
	interface AcknowledgedSafetyCheck {
		id: string;

		code?: string | null;

		message?: string | null;
	}
}

export interface ResponseComputerToolCallOutputScreenshot {
	type: "computer_screenshot";

	file_id?: string;

	image_url?: string;
}

export interface ResponseContainerReference {
	container_id: string;

	type: "container_reference";
}

export type ResponseContent =
	| ResponseInputText
	| ResponseInputImage
	| ResponseInputFile
	| ResponseOutputText
	| ResponseOutputRefusal
	| ResponseContent.ReasoningTextContent;
export declare namespace ResponseContent {
	interface ReasoningTextContent {
		text: string;

		type: "reasoning_text";
	}
}

export interface ResponseContentPartAddedEvent {
	content_index: number;

	item_id: string;

	output_index: number;

	part: ResponseOutputText | ResponseOutputRefusal | ResponseContentPartAddedEvent.ReasoningText;

	sequence_number: number;

	type: "response.content_part.added";
}
export declare namespace ResponseContentPartAddedEvent {
	interface ReasoningText {
		text: string;

		type: "reasoning_text";
	}
}

export interface ResponseContentPartDoneEvent {
	content_index: number;

	item_id: string;

	output_index: number;

	part: ResponseOutputText | ResponseOutputRefusal | ResponseContentPartDoneEvent.ReasoningText;

	sequence_number: number;

	type: "response.content_part.done";
}
export declare namespace ResponseContentPartDoneEvent {
	interface ReasoningText {
		text: string;

		type: "reasoning_text";
	}
}

export interface ResponseConversationParam {
	id: string;
}

export interface ResponseCreatedEvent {
	response: Response;

	sequence_number: number;

	type: "response.created";
}

export interface ResponseCustomToolCall {
	call_id: string;

	input: string;

	name: string;

	type: "custom_tool_call";

	id?: string;

	namespace?: string;
}

export interface ResponseCustomToolCallInputDeltaEvent {
	delta: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.custom_tool_call_input.delta";
}

export interface ResponseCustomToolCallInputDoneEvent {
	input: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.custom_tool_call_input.done";
}

export interface ResponseCustomToolCallItem extends ResponseCustomToolCall {
	id: string;

	status: "in_progress" | "completed" | "incomplete";

	created_by?: string;
}

export interface ResponseCustomToolCallOutput {
	call_id: string;

	output: string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;

	type: "custom_tool_call_output";

	id?: string;
}

export interface ResponseCustomToolCallOutputItem extends ResponseCustomToolCallOutput {
	id: string;

	status: "in_progress" | "completed" | "incomplete";

	created_by?: string;
}

export interface ResponseError {
	code:
		| "server_error"
		| "rate_limit_exceeded"
		| "invalid_prompt"
		| "vector_store_timeout"
		| "invalid_image"
		| "invalid_image_format"
		| "invalid_base64_image"
		| "invalid_image_url"
		| "image_too_large"
		| "image_too_small"
		| "image_parse_error"
		| "image_content_policy_violation"
		| "invalid_image_mode"
		| "image_file_too_large"
		| "unsupported_image_media_type"
		| "empty_image_file"
		| "failed_to_download_image"
		| "image_file_not_found";

	message: string;
}

export interface ResponseErrorEvent {
	code: string | null;

	message: string;

	param: string | null;

	sequence_number: number;

	type: "error";
}

export interface ResponseFailedEvent {
	response: Response;

	sequence_number: number;

	type: "response.failed";
}

export interface ResponseFileSearchCallCompletedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.file_search_call.completed";
}

export interface ResponseFileSearchCallInProgressEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.file_search_call.in_progress";
}

export interface ResponseFileSearchCallSearchingEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.file_search_call.searching";
}

export interface ResponseFileSearchToolCall {
	id: string;

	queries: Array<string>;

	status: "in_progress" | "searching" | "completed" | "incomplete" | "failed";

	type: "file_search_call";

	results?: Array<ResponseFileSearchToolCall.Result> | null;
}
export declare namespace ResponseFileSearchToolCall {
	interface Result {
		attributes?: {
			[key: string]: string | number | boolean;
		} | null;

		file_id?: string;

		filename?: string;

		score?: number;

		text?: string;
	}
}

export type ResponseFormatTextConfig =
	| ResponseFormatText
	| ResponseFormatTextJSONSchemaConfig
	| ResponseFormatJSONObject;

export interface ResponseFormatTextJSONSchemaConfig {
	name: string;

	schema: {
		[key: string]: unknown;
	};

	type: "json_schema";

	description?: string;

	strict?: boolean | null;
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
	delta: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.function_call_arguments.delta";
}

export interface ResponseFunctionCallArgumentsDoneEvent {
	arguments: string;

	item_id: string;

	name: string;

	output_index: number;

	sequence_number: number;
	type: "response.function_call_arguments.done";
}

export type ResponseFunctionCallOutputItem =
	| ResponseInputTextContent
	| ResponseInputImageContent
	| ResponseInputFileContent;

export type ResponseFunctionCallOutputItemList = Array<ResponseFunctionCallOutputItem>;

export interface ResponseFunctionShellCallOutputContent {
	outcome: ResponseFunctionShellCallOutputContent.Timeout | ResponseFunctionShellCallOutputContent.Exit;

	stderr: string;

	stdout: string;
}
export declare namespace ResponseFunctionShellCallOutputContent {
	interface Timeout {
		type: "timeout";
	}

	interface Exit {
		exit_code: number;

		type: "exit";
	}
}

export interface ResponseFunctionShellToolCall {
	id: string;

	action: ResponseFunctionShellToolCall.Action;

	call_id: string;

	environment: ResponseLocalEnvironment | ResponseContainerReference | null;

	status: "in_progress" | "completed" | "incomplete";

	type: "shell_call";

	created_by?: string;
}
export declare namespace ResponseFunctionShellToolCall {
	interface Action {
		commands: Array<string>;

		max_output_length: number | null;

		timeout_ms: number | null;
	}
}

export interface ResponseFunctionShellToolCallOutput {
	id: string;

	call_id: string;

	max_output_length: number | null;

	output: Array<ResponseFunctionShellToolCallOutput.Output>;

	status: "in_progress" | "completed" | "incomplete";

	type: "shell_call_output";

	created_by?: string;
}
export declare namespace ResponseFunctionShellToolCallOutput {
	interface Output {
		outcome: Output.Timeout | Output.Exit;

		stderr: string;

		stdout: string;

		created_by?: string;
	}
	namespace Output {
		interface Timeout {
			type: "timeout";
		}

		interface Exit {
			exit_code: number;

			type: "exit";
		}
	}
}

export interface ResponseFunctionToolCall {
	arguments: string;

	call_id: string;

	name: string;

	type: "function_call";

	id?: string;

	namespace?: string;

	status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseFunctionToolCallItem extends ResponseFunctionToolCall {
	id: string;

	status: "in_progress" | "completed" | "incomplete";

	created_by?: string;
}
export interface ResponseFunctionToolCallOutputItem {
	id: string;

	call_id: string;

	output: string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;

	status: "in_progress" | "completed" | "incomplete";

	type: "function_call_output";

	created_by?: string;
}

export interface ResponseFunctionWebSearch {
	id: string;

	action: ResponseFunctionWebSearch.Search | ResponseFunctionWebSearch.OpenPage | ResponseFunctionWebSearch.Find;

	status: "in_progress" | "searching" | "completed" | "failed";

	type: "web_search_call";
}
export declare namespace ResponseFunctionWebSearch {
	interface Search {
		type: "search";

		queries?: Array<string>;

		query?: string;

		sources?: Array<Search.Source>;
	}
	namespace Search {
		interface Source {
			type: "url";

			url: string;
		}
	}

	interface OpenPage {
		type: "open_page";

		url?: string | null;
	}

	interface Find {
		pattern: string;

		type: "find_in_page";

		url: string;
	}
}

export interface ResponseImageGenCallCompletedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.image_generation_call.completed";
}

export interface ResponseImageGenCallGeneratingEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.image_generation_call.generating";
}

export interface ResponseImageGenCallInProgressEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.image_generation_call.in_progress";
}

export interface ResponseImageGenCallPartialImageEvent {
	item_id: string;

	output_index: number;

	partial_image_b64: string;

	partial_image_index: number;

	sequence_number: number;

	type: "response.image_generation_call.partial_image";
}

export interface ResponseInProgressEvent {
	response: Response;

	sequence_number: number;

	type: "response.in_progress";
}

export type ResponseIncludable =
	| "file_search_call.results"
	| "web_search_call.results"
	| "web_search_call.action.sources"
	| "message.input_image.image_url"
	| "computer_call_output.output.image_url"
	| "code_interpreter_call.outputs"
	| "reasoning.encrypted_content"
	| "message.output_text.logprobs";

export interface ResponseIncompleteEvent {
	response: Response;

	sequence_number: number;

	type: "response.incomplete";
}

export type ResponseInput = Array<ResponseInputItem>;

export interface ResponseInputAudio {
	input_audio: ResponseInputAudio.InputAudio;

	type: "input_audio";
}
export declare namespace ResponseInputAudio {
	interface InputAudio {
		data: string;

		format: "mp3" | "wav";
	}
}

export type ResponseInputContent = ResponseInputText | ResponseInputImage | ResponseInputFile;

export interface ResponseInputFile {
	type: "input_file";

	detail?: "low" | "high";

	file_data?: string;

	file_id?: string | null;

	file_url?: string;

	filename?: string;
}

export interface ResponseInputFileContent {
	type: "input_file";

	detail?: "low" | "high";

	file_data?: string | null;

	file_id?: string | null;

	file_url?: string | null;

	filename?: string | null;
}

export interface ResponseInputImage {
	detail: "low" | "high" | "auto" | "original";

	type: "input_image";

	file_id?: string | null;

	image_url?: string | null;
}

export interface ResponseInputImageContent {
	type: "input_image";

	detail?: "low" | "high" | "auto" | "original" | null;

	file_id?: string | null;

	image_url?: string | null;
}

export type ResponseInputItem =
	| EasyInputMessage
	| ResponseInputItem.Message
	| ResponseOutputMessage
	| ResponseFileSearchToolCall
	| ResponseComputerToolCall
	| ResponseInputItem.ComputerCallOutput
	| ResponseFunctionWebSearch
	| ResponseFunctionToolCall
	| ResponseInputItem.FunctionCallOutput
	| ResponseInputItem.ToolSearchCall
	| ResponseToolSearchOutputItemParam
	| ResponseInputItem.AdditionalTools
	| ResponseReasoningItem
	| ResponseCompactionItemParam
	| ResponseInputItem.ImageGenerationCall
	| ResponseCodeInterpreterToolCall
	| ResponseInputItem.LocalShellCall
	| ResponseInputItem.LocalShellCallOutput
	| ResponseInputItem.ShellCall
	| ResponseInputItem.ShellCallOutput
	| ResponseInputItem.ApplyPatchCall
	| ResponseInputItem.ApplyPatchCallOutput
	| ResponseInputItem.McpListTools
	| ResponseInputItem.McpApprovalRequest
	| ResponseInputItem.McpApprovalResponse
	| ResponseInputItem.McpCall
	| ResponseCustomToolCallOutput
	| ResponseCustomToolCall
	| ResponseInputItem.CompactionTrigger
	| ResponseInputItem.ItemReference;
export declare namespace ResponseInputItem {
	interface Message {
		content: ResponseInputMessageContentList;

		role: "user" | "system" | "developer";

		status?: "in_progress" | "completed" | "incomplete";

		type?: "message";
	}

	interface ComputerCallOutput {
		call_id: string;

		output: ResponseComputerToolCallOutputScreenshot;

		type: "computer_call_output";

		id?: string | null;

		acknowledged_safety_checks?: Array<ComputerCallOutput.AcknowledgedSafetyCheck> | null;

		status?: "in_progress" | "completed" | "incomplete" | null;
	}
	namespace ComputerCallOutput {
		interface AcknowledgedSafetyCheck {
			id: string;

			code?: string | null;

			message?: string | null;
		}
	}

	interface FunctionCallOutput {
		call_id: string;

		output: string | ResponseFunctionCallOutputItemList;

		type: "function_call_output";

		id?: string | null;

		status?: "in_progress" | "completed" | "incomplete" | null;
	}
	interface ToolSearchCall {
		arguments: unknown;

		type: "tool_search_call";

		id?: string | null;

		call_id?: string | null;

		execution?: "server" | "client";

		status?: "in_progress" | "completed" | "incomplete" | null;
	}
	interface AdditionalTools {
		role: "developer";

		tools: Array<Tool>;

		type: "additional_tools";

		id?: string | null;
	}

	interface ImageGenerationCall {
		id: string;

		result: string | null;

		status: "in_progress" | "completed" | "generating" | "failed";

		type: "image_generation_call";
	}

	interface LocalShellCall {
		id: string;

		action: LocalShellCall.Action;

		call_id: string;

		status: "in_progress" | "completed" | "incomplete";

		type: "local_shell_call";
	}
	namespace LocalShellCall {
		interface Action {
			command: Array<string>;

			env: {
				[key: string]: string;
			};

			type: "exec";

			timeout_ms?: number | null;

			user?: string | null;

			working_directory?: string | null;
		}
	}

	interface LocalShellCallOutput {
		id: string;

		output: string;

		type: "local_shell_call_output";

		status?: "in_progress" | "completed" | "incomplete" | null;
	}

	interface ShellCall {
		action: ShellCall.Action;

		call_id: string;

		type: "shell_call";

		id?: string | null;

		environment?: LocalEnvironment | ContainerReference | null;

		status?: "in_progress" | "completed" | "incomplete" | null;
	}
	namespace ShellCall {
		interface Action {
			commands: Array<string>;

			max_output_length?: number | null;

			timeout_ms?: number | null;
		}
	}

	interface ShellCallOutput {
		call_id: string;

		output: Array<ResponseFunctionShellCallOutputContent>;

		type: "shell_call_output";

		id?: string | null;

		max_output_length?: number | null;

		status?: "in_progress" | "completed" | "incomplete" | null;
	}

	interface ApplyPatchCall {
		call_id: string;

		operation: ApplyPatchCall.CreateFile | ApplyPatchCall.DeleteFile | ApplyPatchCall.UpdateFile;

		status: "in_progress" | "completed";

		type: "apply_patch_call";

		id?: string | null;
	}
	namespace ApplyPatchCall {
		interface CreateFile {
			diff: string;

			path: string;

			type: "create_file";
		}

		interface DeleteFile {
			path: string;

			type: "delete_file";
		}

		interface UpdateFile {
			diff: string;

			path: string;

			type: "update_file";
		}
	}

	interface ApplyPatchCallOutput {
		call_id: string;

		status: "completed" | "failed";

		type: "apply_patch_call_output";

		id?: string | null;

		output?: string | null;
	}

	interface McpListTools {
		id: string;

		server_label: string;

		tools: Array<McpListTools.Tool>;

		type: "mcp_list_tools";

		error?: string | null;
	}
	namespace McpListTools {
		interface Tool {
			input_schema: unknown;

			name: string;

			annotations?: unknown | null;

			description?: string | null;
		}
	}

	interface McpApprovalRequest {
		id: string;

		arguments: string;

		name: string;

		server_label: string;

		type: "mcp_approval_request";
	}

	interface McpApprovalResponse {
		approval_request_id: string;

		approve: boolean;

		type: "mcp_approval_response";

		id?: string | null;

		reason?: string | null;
	}

	interface McpCall {
		id: string;

		arguments: string;

		name: string;

		server_label: string;

		type: "mcp_call";

		approval_request_id?: string | null;

		error?: string | null;

		output?: string | null;

		status?: "in_progress" | "completed" | "incomplete" | "calling" | "failed";
	}

	interface CompactionTrigger {
		type: "compaction_trigger";
	}

	interface ItemReference {
		id: string;

		type?: "item_reference" | null;
	}
}

export type ResponseInputMessageContentList = Array<ResponseInputContent>;
export interface ResponseInputMessageItem {
	id: string;

	content: ResponseInputMessageContentList;

	role: "user" | "system" | "developer";

	type: "message";

	status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseInputText {
	text: string;

	type: "input_text";
}

export interface ResponseInputTextContent {
	text: string;

	type: "input_text";
}

export interface ResponseLocalEnvironment {
	type: "local";
}

export interface ResponseMcpCallArgumentsDeltaEvent {
	delta: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_call_arguments.delta";
}

export interface ResponseMcpCallArgumentsDoneEvent {
	arguments: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_call_arguments.done";
}

export interface ResponseMcpCallCompletedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_call.completed";
}

export interface ResponseMcpCallFailedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_call.failed";
}

export interface ResponseMcpCallInProgressEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_call.in_progress";
}

export interface ResponseMcpListToolsCompletedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_list_tools.completed";
}

export interface ResponseMcpListToolsFailedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_list_tools.failed";
}

export interface ResponseMcpListToolsInProgressEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.mcp_list_tools.in_progress";
}

export interface ResponseOutputAudio {
	data: string;

	transcript: string;

	type: "output_audio";
}

export type ResponseOutputItem =
	| ResponseOutputMessage
	| ResponseFileSearchToolCall
	| ResponseFunctionToolCall
	| ResponseFunctionToolCallOutputItem
	| ResponseFunctionWebSearch
	| ResponseComputerToolCall
	| ResponseComputerToolCallOutputItem
	| ResponseReasoningItem
	| ResponseToolSearchCall
	| ResponseToolSearchOutputItem
	| ResponseOutputItem.AdditionalTools
	| ResponseCompactionItem
	| ResponseOutputItem.ImageGenerationCall
	| ResponseCodeInterpreterToolCall
	| ResponseOutputItem.LocalShellCall
	| ResponseOutputItem.LocalShellCallOutput
	| ResponseFunctionShellToolCall
	| ResponseFunctionShellToolCallOutput
	| ResponseApplyPatchToolCall
	| ResponseApplyPatchToolCallOutput
	| ResponseOutputItem.McpCall
	| ResponseOutputItem.McpListTools
	| ResponseOutputItem.McpApprovalRequest
	| ResponseOutputItem.McpApprovalResponse
	| ResponseCustomToolCall
	| ResponseCustomToolCallOutputItem;
export declare namespace ResponseOutputItem {
	interface AdditionalTools {
		id: string;

		role: "unknown" | "user" | "assistant" | "system" | "critic" | "discriminator" | "developer" | "tool";

		tools: Array<Tool>;

		type: "additional_tools";
	}

	interface ImageGenerationCall {
		id: string;

		result: string | null;

		status: "in_progress" | "completed" | "generating" | "failed";

		type: "image_generation_call";
	}

	interface LocalShellCall {
		id: string;

		action: LocalShellCall.Action;

		call_id: string;

		status: "in_progress" | "completed" | "incomplete";

		type: "local_shell_call";
	}
	namespace LocalShellCall {
		interface Action {
			command: Array<string>;

			env: {
				[key: string]: string;
			};

			type: "exec";

			timeout_ms?: number | null;

			user?: string | null;

			working_directory?: string | null;
		}
	}

	interface LocalShellCallOutput {
		id: string;

		output: string;

		type: "local_shell_call_output";

		status?: "in_progress" | "completed" | "incomplete" | null;
	}

	interface McpCall {
		id: string;

		arguments: string;

		name: string;

		server_label: string;

		type: "mcp_call";

		approval_request_id?: string | null;

		error?: string | null;

		output?: string | null;

		status?: "in_progress" | "completed" | "incomplete" | "calling" | "failed";
	}

	interface McpListTools {
		id: string;

		server_label: string;

		tools: Array<McpListTools.Tool>;

		type: "mcp_list_tools";

		error?: string | null;
	}
	namespace McpListTools {
		interface Tool {
			input_schema: unknown;

			name: string;

			annotations?: unknown | null;

			description?: string | null;
		}
	}

	interface McpApprovalRequest {
		id: string;

		arguments: string;

		name: string;

		server_label: string;

		type: "mcp_approval_request";
	}

	interface McpApprovalResponse {
		id: string;

		approval_request_id: string;

		approve: boolean;

		type: "mcp_approval_response";

		reason?: string | null;
	}
}

export interface ResponseOutputItemAddedEvent {
	item: ResponseOutputItem;

	output_index: number;

	sequence_number: number;

	type: "response.output_item.added";
}

export interface ResponseOutputItemDoneEvent {
	item: ResponseOutputItem;

	output_index: number;

	sequence_number: number;

	type: "response.output_item.done";
}

export interface ResponseOutputMessage {
	id: string;

	content: Array<ResponseOutputText | ResponseOutputRefusal>;

	role: "assistant";

	status: "in_progress" | "completed" | "incomplete";

	type: "message";

	phase?: "commentary" | "final_answer" | null;
}

export interface ResponseOutputRefusal {
	refusal: string;

	type: "refusal";
}

export interface ResponseOutputText {
	annotations: Array<
		| ResponseOutputText.FileCitation
		| ResponseOutputText.URLCitation
		| ResponseOutputText.ContainerFileCitation
		| ResponseOutputText.FilePath
	>;

	text: string;

	type: "output_text";
	logprobs?: Array<ResponseOutputText.Logprob>;
}
export declare namespace ResponseOutputText {
	interface FileCitation {
		file_id: string;

		filename: string;

		index: number;

		type: "file_citation";
	}

	interface URLCitation {
		end_index: number;

		start_index: number;

		title: string;

		type: "url_citation";

		url: string;
	}

	interface ContainerFileCitation {
		container_id: string;

		end_index: number;

		file_id: string;

		filename: string;

		start_index: number;

		type: "container_file_citation";
	}

	interface FilePath {
		file_id: string;

		index: number;

		type: "file_path";
	}

	interface Logprob {
		token: string;
		bytes: Array<number>;
		logprob: number;
		top_logprobs: Array<Logprob.TopLogprob>;
	}
	namespace Logprob {
		interface TopLogprob {
			token: string;
			bytes: Array<number>;
			logprob: number;
		}
	}
}

export interface ResponseOutputTextAnnotationAddedEvent {
	annotation: unknown;

	annotation_index: number;

	content_index: number;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.output_text.annotation.added";
}

export interface ResponsePrompt {
	id: string;

	variables?: {
		[key: string]: string | ResponseInputText | ResponseInputImage | ResponseInputFile;
	} | null;

	version?: string | null;
}

export interface ResponseQueuedEvent {
	response: Response;

	sequence_number: number;

	type: "response.queued";
}

export interface ResponseReasoningItem {
	id: string;

	summary: Array<ResponseReasoningItem.Summary>;

	type: "reasoning";

	content?: Array<ResponseReasoningItem.Content>;

	encrypted_content?: string | null;

	status?: "in_progress" | "completed" | "incomplete";
}
export declare namespace ResponseReasoningItem {
	interface Summary {
		text: string;

		type: "summary_text";
	}

	interface Content {
		text: string;

		type: "reasoning_text";
	}
}

export interface ResponseReasoningSummaryPartAddedEvent {
	item_id: string;

	output_index: number;

	part: ResponseReasoningSummaryPartAddedEvent.Part;

	sequence_number: number;

	summary_index: number;

	type: "response.reasoning_summary_part.added";
}
export declare namespace ResponseReasoningSummaryPartAddedEvent {
	interface Part {
		text: string;

		type: "summary_text";
	}
}

export interface ResponseReasoningSummaryPartDoneEvent {
	item_id: string;

	output_index: number;

	part: ResponseReasoningSummaryPartDoneEvent.Part;

	sequence_number: number;

	summary_index: number;

	type: "response.reasoning_summary_part.done";
}
export declare namespace ResponseReasoningSummaryPartDoneEvent {
	interface Part {
		text: string;

		type: "summary_text";
	}
}

export interface ResponseReasoningSummaryTextDeltaEvent {
	delta: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	summary_index: number;

	type: "response.reasoning_summary_text.delta";
}

export interface ResponseReasoningSummaryTextDoneEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	summary_index: number;

	text: string;

	type: "response.reasoning_summary_text.done";
}

export interface ResponseReasoningTextDeltaEvent {
	content_index: number;

	delta: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.reasoning_text.delta";
}

export interface ResponseReasoningTextDoneEvent {
	content_index: number;

	item_id: string;

	output_index: number;

	sequence_number: number;

	text: string;

	type: "response.reasoning_text.done";
}

export interface ResponseRefusalDeltaEvent {
	content_index: number;

	delta: string;

	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.refusal.delta";
}

export interface ResponseRefusalDoneEvent {
	content_index: number;

	item_id: string;

	output_index: number;

	refusal: string;

	sequence_number: number;

	type: "response.refusal.done";
}

export type ResponseStatus = "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";

export type ResponseStreamEvent =
	| ResponseAudioDeltaEvent
	| ResponseAudioDoneEvent
	| ResponseAudioTranscriptDeltaEvent
	| ResponseAudioTranscriptDoneEvent
	| ResponseCodeInterpreterCallCodeDeltaEvent
	| ResponseCodeInterpreterCallCodeDoneEvent
	| ResponseCodeInterpreterCallCompletedEvent
	| ResponseCodeInterpreterCallInProgressEvent
	| ResponseCodeInterpreterCallInterpretingEvent
	| ResponseCompletedEvent
	| ResponseContentPartAddedEvent
	| ResponseContentPartDoneEvent
	| ResponseCreatedEvent
	| ResponseErrorEvent
	| ResponseFileSearchCallCompletedEvent
	| ResponseFileSearchCallInProgressEvent
	| ResponseFileSearchCallSearchingEvent
	| ResponseFunctionCallArgumentsDeltaEvent
	| ResponseFunctionCallArgumentsDoneEvent
	| ResponseInProgressEvent
	| ResponseFailedEvent
	| ResponseIncompleteEvent
	| ResponseOutputItemAddedEvent
	| ResponseOutputItemDoneEvent
	| ResponseReasoningSummaryPartAddedEvent
	| ResponseReasoningSummaryPartDoneEvent
	| ResponseReasoningSummaryTextDeltaEvent
	| ResponseReasoningSummaryTextDoneEvent
	| ResponseReasoningTextDeltaEvent
	| ResponseReasoningTextDoneEvent
	| ResponseRefusalDeltaEvent
	| ResponseRefusalDoneEvent
	| ResponseTextDeltaEvent
	| ResponseTextDoneEvent
	| ResponseWebSearchCallCompletedEvent
	| ResponseWebSearchCallInProgressEvent
	| ResponseWebSearchCallSearchingEvent
	| ResponseImageGenCallCompletedEvent
	| ResponseImageGenCallGeneratingEvent
	| ResponseImageGenCallInProgressEvent
	| ResponseImageGenCallPartialImageEvent
	| ResponseMcpCallArgumentsDeltaEvent
	| ResponseMcpCallArgumentsDoneEvent
	| ResponseMcpCallCompletedEvent
	| ResponseMcpCallFailedEvent
	| ResponseMcpCallInProgressEvent
	| ResponseMcpListToolsCompletedEvent
	| ResponseMcpListToolsFailedEvent
	| ResponseMcpListToolsInProgressEvent
	| ResponseOutputTextAnnotationAddedEvent
	| ResponseQueuedEvent
	| ResponseCustomToolCallInputDeltaEvent
	| ResponseCustomToolCallInputDoneEvent;

export interface ResponseTextConfig {
	format?: ResponseFormatTextConfig;

	verbosity?: "low" | "medium" | "high" | null;
}

export interface ResponseTextDeltaEvent {
	content_index: number;

	delta: string;

	item_id: string;

	logprobs: Array<ResponseTextDeltaEvent.Logprob>;

	output_index: number;

	sequence_number: number;

	type: "response.output_text.delta";
}
export declare namespace ResponseTextDeltaEvent {
	interface Logprob {
		token: string;

		logprob: number;

		top_logprobs?: Array<Logprob.TopLogprob>;
	}
	namespace Logprob {
		interface TopLogprob {
			token?: string;

			logprob?: number;
		}
	}
}

export interface ResponseTextDoneEvent {
	content_index: number;

	item_id: string;

	logprobs: Array<ResponseTextDoneEvent.Logprob>;

	output_index: number;

	sequence_number: number;

	text: string;

	type: "response.output_text.done";
}
export declare namespace ResponseTextDoneEvent {
	interface Logprob {
		token: string;

		logprob: number;

		top_logprobs?: Array<Logprob.TopLogprob>;
	}
	namespace Logprob {
		interface TopLogprob {
			token?: string;

			logprob?: number;
		}
	}
}
export interface ResponseToolSearchCall {
	id: string;

	arguments: unknown;

	call_id: string | null;

	execution: "server" | "client";

	status: "in_progress" | "completed" | "incomplete";

	type: "tool_search_call";

	created_by?: string;
}
export interface ResponseToolSearchOutputItem {
	id: string;

	call_id: string | null;

	execution: "server" | "client";

	status: "in_progress" | "completed" | "incomplete";

	tools: Array<Tool>;

	type: "tool_search_output";

	created_by?: string;
}
export interface ResponseToolSearchOutputItemParam {
	tools: Array<Tool>;

	type: "tool_search_output";

	id?: string | null;

	call_id?: string | null;

	execution?: "server" | "client";

	status?: "in_progress" | "completed" | "incomplete" | null;
}

export interface ResponseUsage {
	input_tokens: number;

	input_tokens_details: ResponseUsage.InputTokensDetails;

	output_tokens: number;

	output_tokens_details: ResponseUsage.OutputTokensDetails;

	total_tokens: number;
}
export declare namespace ResponseUsage {
	interface InputTokensDetails {
		cached_tokens: number;
	}

	interface OutputTokensDetails {
		reasoning_tokens: number;
	}
}

export interface ResponseWebSearchCallCompletedEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.web_search_call.completed";
}

export interface ResponseWebSearchCallInProgressEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.web_search_call.in_progress";
}

export interface ResponseWebSearchCallSearchingEvent {
	item_id: string;

	output_index: number;

	sequence_number: number;

	type: "response.web_search_call.searching";
}
export interface SkillReference {
	skill_id: string;

	type: "skill_reference";

	version?: string;
}

export type Tool =
	| FunctionTool
	| FileSearchTool
	| ComputerTool
	| ComputerUsePreviewTool
	| WebSearchTool
	| Tool.Mcp
	| Tool.CodeInterpreter
	| Tool.ImageGeneration
	| Tool.LocalShell
	| FunctionShellTool
	| CustomTool
	| NamespaceTool
	| ToolSearchTool
	| WebSearchPreviewTool
	| ApplyPatchTool;
export declare namespace Tool {
	interface Mcp {
		server_label: string;

		type: "mcp";

		allowed_tools?: Array<string> | Mcp.McpToolFilter | null;

		authorization?: string;

		connector_id?:
			| "connector_dropbox"
			| "connector_gmail"
			| "connector_googlecalendar"
			| "connector_googledrive"
			| "connector_microsoftteams"
			| "connector_outlookcalendar"
			| "connector_outlookemail"
			| "connector_sharepoint";

		defer_loading?: boolean;

		headers?: {
			[key: string]: string;
		} | null;

		require_approval?: Mcp.McpToolApprovalFilter | "always" | "never" | null;

		server_description?: string;

		server_url?: string;
	}
	namespace Mcp {
		interface McpToolFilter {
			read_only?: boolean;

			tool_names?: Array<string>;
		}

		interface McpToolApprovalFilter {
			always?: McpToolApprovalFilter.Always;

			never?: McpToolApprovalFilter.Never;
		}
		namespace McpToolApprovalFilter {
			interface Always {
				read_only?: boolean;

				tool_names?: Array<string>;
			}

			interface Never {
				read_only?: boolean;

				tool_names?: Array<string>;
			}
		}
	}

	interface CodeInterpreter {
		container: string | CodeInterpreter.CodeInterpreterToolAuto;

		type: "code_interpreter";
	}
	namespace CodeInterpreter {
		interface CodeInterpreterToolAuto {
			type: "auto";

			file_ids?: Array<string>;

			memory_limit?: "1g" | "4g" | "16g" | "64g" | null;

			network_policy?: ContainerNetworkPolicyDisabled | ContainerNetworkPolicyAllowlist;
		}
	}

	interface ImageGeneration {
		type: "image_generation";

		action?: "generate" | "edit" | "auto";

		background?: "transparent" | "opaque" | "auto";

		input_fidelity?: "high" | "low" | null;

		input_image_mask?: ImageGeneration.InputImageMask;

		model?:
			| (string & {})
			| "gpt-image-1"
			| "gpt-image-1-mini"
			| "gpt-image-2"
			| "gpt-image-2-2026-04-21"
			| "gpt-image-1.5"
			| "chatgpt-image-latest";

		moderation?: "auto" | "low";

		output_compression?: number;

		output_format?: "png" | "webp" | "jpeg";

		partial_images?: number;

		quality?: "low" | "medium" | "high" | "auto";

		size?: (string & {}) | "1024x1024" | "1024x1536" | "1536x1024" | "auto";
	}
	namespace ImageGeneration {
		interface InputImageMask {
			file_id?: string;

			image_url?: string;
		}
	}

	interface LocalShell {
		type: "local_shell";
	}
}

export interface ToolChoiceAllowed {
	mode: "auto" | "required";

	tools: Array<{
		[key: string]: unknown;
	}>;

	type: "allowed_tools";
}

export interface ToolChoiceApplyPatch {
	type: "apply_patch";
}

export interface ToolChoiceCustom {
	name: string;

	type: "custom";
}

export interface ToolChoiceFunction {
	name: string;

	type: "function";
}

export interface ToolChoiceMcp {
	server_label: string;

	type: "mcp";

	name?: string | null;
}

export type ToolChoiceOptions = "none" | "auto" | "required";

export interface ToolChoiceShell {
	type: "shell";
}

export interface ToolChoiceTypes {
	type:
		| "file_search"
		| "web_search_preview"
		| "computer"
		| "computer_use_preview"
		| "computer_use"
		| "web_search_preview_2025_03_11"
		| "image_generation"
		| "code_interpreter"
		| "mcp";
}

export interface ToolSearchTool {
	type: "tool_search";

	description?: string | null;

	execution?: "server" | "client";

	parameters?: unknown | null;
}

export interface WebSearchPreviewTool {
	type: "web_search_preview" | "web_search_preview_2025_03_11";
	search_content_types?: Array<"text" | "image">;

	search_context_size?: "low" | "medium" | "high";

	user_location?: WebSearchPreviewTool.UserLocation | null;
}
export declare namespace WebSearchPreviewTool {
	interface UserLocation {
		type: "approximate";

		city?: string | null;

		country?: string | null;

		region?: string | null;

		timezone?: string | null;
	}
}

export interface WebSearchTool {
	type: "web_search" | "web_search_2025_08_26";

	filters?: WebSearchTool.Filters | null;

	search_context_size?: "low" | "medium" | "high";

	user_location?: WebSearchTool.UserLocation | null;
}
export declare namespace WebSearchTool {
	interface Filters {
		allowed_domains?: Array<string> | null;
	}

	interface UserLocation {
		city?: string | null;

		country?: string | null;

		region?: string | null;

		timezone?: string | null;

		type?: "approximate";
	}
}
export type ResponseCreateParams = ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming;
export interface ResponseCreateParamsBase {
	background?: boolean | null;

	context_management?: Array<ResponseCreateParams.ContextManagement> | null;

	conversation?: string | ResponseConversationParam | null;

	include?: Array<ResponseIncludable> | null;

	input?: ResponseInput;

	instructions?: string | null;

	max_output_tokens?: number | null;

	metadata?: Metadata | null;

	model?: ResponsesModel;

	moderation?: ResponseCreateParams.Moderation | null;

	parallel_tool_calls?: boolean | null;

	previous_response_id?: string | null;

	prompt?: ResponsePrompt | null;

	prompt_cache_key?: string;

	prompt_cache_retention?: "in_memory" | "24h" | null;

	reasoning?: Reasoning | null;

	safety_identifier?: string;

	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;

	store?: boolean | null;

	stream?: boolean | null;

	stream_options?: ResponseCreateParams.StreamOptions | null;

	temperature?: number | null;

	text?: ResponseTextConfig;

	tool_choice?:
		| ToolChoiceOptions
		| ToolChoiceAllowed
		| ToolChoiceTypes
		| ToolChoiceFunction
		| ToolChoiceMcp
		| ToolChoiceCustom
		| ToolChoiceApplyPatch
		| ToolChoiceShell;

	tools?: Array<Tool>;

	top_logprobs?: number | null;

	top_p?: number | null;

	truncation?: "auto" | "disabled" | null;

	user?: string;
}
export declare namespace ResponseCreateParams {
	interface ContextManagement {
		type: string;

		compact_threshold?: number | null;
	}

	interface Moderation {
		model: string;
	}

	interface StreamOptions {
		include_obfuscation?: boolean;
	}
}
export interface ResponseCreateParamsNonStreaming extends ResponseCreateParamsBase {
	stream?: false | null;
}
export interface ResponseCreateParamsStreaming extends ResponseCreateParamsBase {
	stream: true;
}

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

export interface ComparisonFilter {
	key: string;

	type: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin";

	value: string | number | boolean | Array<string | number>;
}

export interface CompoundFilter {
	filters: Array<ComparisonFilter | unknown>;

	type: "and" | "or";
}

export type CustomToolInputFormat = CustomToolInputFormat.Text | CustomToolInputFormat.Grammar;
export declare namespace CustomToolInputFormat {
	interface Text {
		type: "text";
	}

	interface Grammar {
		definition: string;

		syntax: "lark" | "regex";

		type: "grammar";
	}
}

export type FunctionParameters = {
	[key: string]: unknown;
};

export type Metadata = {
	[key: string]: string;
};

export interface Reasoning {
	effort?: ReasoningEffort | null;

	mode?: "pro" | null;

	generate_summary?: "auto" | "concise" | "detailed" | null;

	summary?: "auto" | "concise" | "detailed" | null;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;

export interface ResponseFormatJSONObject {
	type: "json_object";
}

export interface ResponseFormatText {
	type: "text";
}
export type ResponsesModel =
	| (string & {})
	| ChatModel
	| "o1-pro"
	| "o1-pro-2025-03-19"
	| "o3-pro"
	| "o3-pro-2025-06-10"
	| "o3-deep-research"
	| "o3-deep-research-2025-06-26"
	| "o4-mini-deep-research"
	| "o4-mini-deep-research-2025-06-26"
	| "computer-use-preview"
	| "computer-use-preview-2025-03-11"
	| "gpt-5-codex"
	| "gpt-5-pro"
	| "gpt-5-pro-2025-10-06"
	| "gpt-5.1-codex-max";
