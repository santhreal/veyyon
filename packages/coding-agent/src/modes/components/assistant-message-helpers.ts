import type { AssistantMessage } from "@veyyon/ai";
import { theme } from "../../modes/theme/theme";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";

export const MAX_TRANSCRIPT_ERROR_LINES = 8;

export const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
export type DisplayThinkingContentBlock = ThinkingContentBlock & { rawThinking?: string };

export function resolveThinkingDisplay(
	block: ThinkingContentBlock,
	proseOnly: boolean,
): { text: string; visible: boolean } {
	const rawThinking = (block as DisplayThinkingContentBlock).rawThinking;
	const formatted = rawThinking !== undefined ? block.thinking : formatThinkingForDisplay(block.thinking, proseOnly);
	return {
		text: formatted.trim(),
		visible: hasDisplayableThinking(rawThinking ?? block.thinking, formatted),
	};
}

export function containsMermaidFence(text: string): boolean {
	let fence: string | null = null;
	const lines = text.split("\n");
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
		const fenceMatch = CODE_FENCE_LINE.exec(line);
		if (fence !== null) {
			if (
				fenceMatch &&
				fenceMatch[2]!.trim() === "" &&
				fenceMatch[1]![0] === fence[0] &&
				fenceMatch[1]!.length >= fence.length
			) {
				fence = null;
			}
			continue;
		}
		if (fenceMatch) {
			if (/^mermaid\b/.test(fenceMatch[2]!.trim())) return true;
			fence = fenceMatch[1]!;
		}
	}
	return false;
}

export function thinkingPulseFrames(): readonly string[] {
	return theme.getSpinnerFrames("thinking");
}
export const THINKING_DOTS_FRAME_MS_MIN = 70;
export const THINKING_DOTS_FRAME_MS_MAX = 230;

export const SHIMMER_TICK_MS = 1000 / 30;

export const SPEED_WINDOW_MS = 3000;
export const SPEED_MAX = 200;
