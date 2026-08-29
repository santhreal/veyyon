import { THINK_CLOSE, THINK_OPEN, XML_THINKING_CLOSE, XML_THINKING_OPEN } from "./wire-tags";

export type Tag = { readonly open: string; readonly close: string; readonly fenced?: boolean };

export const TAGS: readonly Tag[] = [
	{ open: THINK_OPEN, close: THINK_CLOSE }, // deepseek, glm, hermes, kimi, qwen3 (and anthropic/minimax/xml)
	{ open: XML_THINKING_OPEN, close: XML_THINKING_CLOSE }, // anthropic, minimax, xml
	{ open: "<scratchpad>", close: "</scratchpad>" }, // anthropic
	{ open: "```thinking\n", close: "```", fenced: true }, // gemini fenced thinking
	{ open: "<|channel>thought\n", close: "<channel|>" }, // gemma reasoning channel
	{ open: "<|start|>assistant<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (rendered)
	{ open: "<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (bare leak)
];
export const OPENS = TAGS.map(tag => tag.open);
