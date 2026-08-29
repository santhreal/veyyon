export const MAX_PARTIAL_TAG_LENGTH = 256;
export const MAX_PARAMETER_VALUE_LENGTH = 1_000_000;

export const WRAPPER_TAGS: Readonly<Record<string, true>> = { function_calls: true, tool_calls: true };
export const THINKING_TAGS: Record<string, true> = { thinking: true, think: true, scratchpad: true };
export const BASE_TAG_PREFIXES = [
	"<function_calls",
	"</function_calls",
	"<tool_calls",
	"</tool_calls",
	"<invoke",
	"</invoke",
	"<parameter",
	"</parameter",
	"<antml:function_calls",
	"</antml:function_calls",
	"<antml:tool_calls",
	"</antml:tool_calls",
	"<antml:invoke",
	"</antml:invoke",
	"<antml:parameter",
	"</antml:parameter",
] as const;
export const ANTHROPIC_THINKING_TAG_PREFIXES = [
	"<thinking",
	"</thinking",
	"<think",
	"</think",
	"<scratchpad",
	"</scratchpad",
	"<antml:thinking",
	"</antml:thinking",
	"<antml:think",
	"</antml:think",
	"<antml:scratchpad",
	"</antml:scratchpad",
] as const;

export interface AnthropicInbandScannerConfig {
	readonly wrapperTags?: Readonly<Record<string, true>>;
	readonly baseTagPrefixes?: readonly string[];
	readonly allTagPrefixes?: readonly string[];
}
export type ScannerState = "outside" | "section" | "invoke" | "parameter" | "thinking";
export type ReturnState = "outside" | "section";

export interface ParsedTag {
	readonly raw: string;
	readonly localName: string;
	readonly prefix: string;
	readonly closing: boolean;
	readonly selfClosing: boolean;
	readonly attrs: ReadonlyMap<string, string>;
}

export type TagRead = ParsedTag | "partial" | undefined;
