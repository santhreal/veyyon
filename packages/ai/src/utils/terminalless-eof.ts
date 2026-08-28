import type { AssistantMessage } from "../types";

export type TerminallessStopReason = "stop" | "toolUse" | "length";

export function stopReasonForTerminallessEof(
	content: AssistantMessage["content"],
	toolBatchIsComplete: boolean,
): TerminallessStopReason | undefined {
	const hasToolCalls = content.some(block => block.type === "toolCall");
	if (hasToolCalls) return toolBatchIsComplete ? "toolUse" : undefined;
	if (content.some(block => block.type === "text" && block.text.trim().length > 0)) return "stop";
	if (content.some(block => block.type === "thinking" && block.thinking.trim().length > 0)) return "length";
	return undefined;
}
