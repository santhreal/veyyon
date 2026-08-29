import { THINK_CLOSE, THINK_OPEN } from "./wire-tags";

export const DEEPSEEK_TOOL_CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
export const DEEPSEEK_TOOL_CALLS_END = "<｜tool▁calls▁end｜>";
export const DEEPSEEK_TOOL_CALL_BEGIN = "<｜tool▁call▁begin｜>";
export const DEEPSEEK_TOOL_CALL_END = "<｜tool▁call▁end｜>";
export const DEEPSEEK_TOOL_SEPARATOR = "<｜tool▁sep｜>";
export const DEEPSEEK_TOOL_OUTPUT_BEGIN = "<｜tool▁output▁begin｜>";
export const DEEPSEEK_TOOL_OUTPUT_END = "<｜tool▁output▁end｜>";
export const DEEPSEEK_BOS = "<｜begin▁of▁sentence｜>";
export const DEEPSEEK_USER = "<｜User｜>";
export const DEEPSEEK_ASSISTANT = "<｜Assistant｜>";
export const DEEPSEEK_EOS = "<｜end▁of▁sentence｜>";

export const LEGACY_TOOL_TYPE = "function";
export const LEGACY_JSON_FENCE = "```json";

export const DSML_TOOL_CALLS_OPEN_FULLWIDTH = "<｜DSML｜tool_calls>";
export const DSML_TOOL_CALLS_CLOSE_FULLWIDTH = "</｜DSML｜tool_calls>";
export const DSML_TOOL_CALLS_OPEN_ASCII = "<|DSML|tool_calls>";
export const DSML_TOOL_CALLS_CLOSE_ASCII = "</|DSML|tool_calls>";

export const CONTROL_TOKENS = [
	DEEPSEEK_BOS,
	DEEPSEEK_EOS,
	"<｜▁pad▁｜>",
	DEEPSEEK_USER,
	DEEPSEEK_ASSISTANT,
	"<|EOT|>",
	"<｜search▁begin｜>",
	"<｜search▁end｜>",
	"<｜fim▁hole｜>",
	"<｜fim▁begin｜>",
	"<｜fim▁end｜>",
	"<｜tool▁outputs▁begin｜>",
	"<｜tool▁outputs▁end｜>",
	DEEPSEEK_TOOL_OUTPUT_BEGIN,
	DEEPSEEK_TOOL_OUTPUT_END,
] as const;

export const OUTSIDE_TOKENS = [
	DEEPSEEK_TOOL_CALLS_BEGIN,
	DEEPSEEK_TOOL_CALLS_END,
	DEEPSEEK_TOOL_CALL_BEGIN,
	THINK_OPEN,
	THINK_CLOSE,
	DSML_TOOL_CALLS_OPEN_FULLWIDTH,
	DSML_TOOL_CALLS_OPEN_ASCII,
	DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
	DSML_TOOL_CALLS_CLOSE_ASCII,
	...CONTROL_TOKENS,
] as const;

export const SECTION_TOKENS = [DEEPSEEK_TOOL_CALL_BEGIN, DEEPSEEK_TOOL_CALLS_END] as const;
export const DSML_SECTION_TOKENS = [
	DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
	DSML_TOOL_CALLS_CLOSE_ASCII,
	"<｜DSML｜invoke",
	"<|DSML|invoke",
] as const;
export const DSML_INVOKE_TOKENS = [
	"</｜DSML｜invoke>",
	"</|DSML|invoke>",
	"<｜DSML｜parameter",
	"<|DSML|parameter",
] as const;
export const DSML_PARAMETER_CLOSE_TOKENS = ["</｜DSML｜parameter>", "</|DSML|parameter>"] as const;

export type State =
	| "outside"
	| "thinking"
	| "section"
	| "header"
	| "args"
	| "legacyName"
	| "legacyArgs"
	| "dsmlSection"
	| "dsmlInvoke"
	| "dsmlParam";
