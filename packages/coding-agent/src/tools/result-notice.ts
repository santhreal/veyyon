/** The cross-cutting notice injector, in a leaf so a caller does not pay for the result builder. It used to live in `tools/tool-result.ts` beside `ToolResultBuilder`, which imports */
import type { AgentToolResult } from "@veyyon/agent-core";
import type { TextContent } from "@veyyon/ai";

/** Prepend a notice line to an already-built tool result so it reaches the agent. Reuses the result's first text block when present, otherwise inserts a new one, and leaves */
export function prependResultNotice<TDetails>(
	result: AgentToolResult<TDetails>,
	notice: string,
): AgentToolResult<TDetails> {
	const content = result.content.slice();
	const firstText = content.findIndex(block => block.type === "text");
	if (firstText >= 0) {
		const block = content[firstText] as TextContent;
		content[firstText] = { ...block, text: `${notice}\n\n${block.text}` };
	} else {
		content.unshift({ type: "text", text: notice });
	}
	return { ...result, content };
}
