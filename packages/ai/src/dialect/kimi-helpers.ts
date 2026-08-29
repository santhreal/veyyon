import { THINK_OPEN } from "./wire-tags";

export const KIMI_SECTION_BEGIN = "<|tool_calls_section_begin|>";
export const KIMI_SECTION_END = "<|tool_calls_section_end|>";
export const KIMI_CALL_BEGIN = "<|tool_call_begin|>";
export const KIMI_CALL_END = "<|tool_call_end|>";
export const KIMI_ARG_BEGIN = "<|tool_call_argument_begin|>";

export const TOKENS = [KIMI_SECTION_BEGIN, KIMI_SECTION_END, KIMI_CALL_BEGIN, KIMI_CALL_END, KIMI_ARG_BEGIN] as const;
export const TOKENS_THINK = [
	KIMI_SECTION_BEGIN,
	KIMI_SECTION_END,
	KIMI_CALL_BEGIN,
	KIMI_CALL_END,
	KIMI_ARG_BEGIN,
	THINK_OPEN,
] as const;

export type State = "outside" | "section" | "header" | "args" | "thinking";
