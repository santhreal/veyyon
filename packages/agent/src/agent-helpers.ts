import type { Message, ToolChoice } from "@veyyon/ai";
import { isProviderRefusalMessage } from "./replay-policy";
import type { AgentContext, AgentMessage } from "./types";

export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => {
		if (m.role === "assistant") return !isProviderRefusalMessage(m);
		return m.role === "user" || m.role === "toolResult";
	});
}

export const ANTHROPIC_OUTPUT_BLOCKED_PREFIX = "Output blocked by conten";

export function isAnthropicOutputBlockedError(message: string): boolean {
	return message.includes(ANTHROPIC_OUTPUT_BLOCKED_PREFIX);
}

export function refreshToolChoiceForActiveTools(
	toolChoice: ToolChoice | undefined,
	tools: AgentContext["tools"] = [],
): ToolChoice | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return toolChoice;
	}

	const toolName =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;

	return tools.some(tool => tool.name === toolName) ? toolChoice : undefined;
}
