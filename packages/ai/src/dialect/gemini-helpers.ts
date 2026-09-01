export const CODE_OPEN = "```tool_code";
export const OUTPUT_OPEN = "```tool_outputs";
export const OPEN_TAGS = [CODE_OPEN] as const;
export const GEMINI_THINK_FENCE_OPEN = "```thinking\n";
export const OPEN_TAGS_THINK = [CODE_OPEN, GEMINI_THINK_FENCE_OPEN] as const;

export type State = "outside" | "tool" | "thinking";

export interface ParsedCall {
	name: string;
	arguments: Record<string, unknown>;
}
