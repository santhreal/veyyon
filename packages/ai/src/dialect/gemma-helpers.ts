export const GEMMA_CALL_OPEN = "<|tool_call>";
export const GEMMA_CALL_CLOSE = "<tool_call|>";
export const STRING = '<|"|>';
export const GEMMA_RESPONSE_OPEN = "<|tool_response>";
export const GEMMA_RESPONSE_CLOSE = "<tool_response|>";
export const OPEN_TAGS = [GEMMA_CALL_OPEN] as const;
export const GEMMA_THOUGHT_OPEN = "<|channel>thought\n";
export const GEMMA_THOUGHT_CLOSE = "<channel|>";
export const OPEN_TAGS_THINK = [GEMMA_CALL_OPEN, GEMMA_THOUGHT_OPEN] as const;
export const CALL_HEAD = /^call:\s*([A-Za-z_]\w*)\s*\{/;

export type State = "outside" | "tool" | "thinking";

export interface ParsedCall {
	name: string;
	arguments: Record<string, unknown>;
}
