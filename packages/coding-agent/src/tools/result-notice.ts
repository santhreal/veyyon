/**
 * The cross-cutting notice injector, in a leaf so a caller does not pay for the result builder.
 *
 * It used to live in `tools/tool-result.ts` beside `ToolResultBuilder`, which imports
 * `tools/output-meta` and 150 modules behind it -- the settings tree, the streaming-output
 * summariser, the render helpers. This function touches none of that: it takes a built result and
 * a string and returns a new result. `lsp/index.ts` imported it and paid the full 151.
 */
import type { AgentToolResult } from "@veyyon/agent-core";
import type { TextContent } from "@veyyon/ai";

/**
 * Prepend a notice line to an already-built tool result so it reaches the agent.
 *
 * Reuses the result's first text block when present, otherwise inserts a new one, and leaves
 * details/isError/useless untouched. Use this to surface a cross-cutting notice (for example a
 * clamped timeout) from a wrapper that sits above many per-action result builders, so the message
 * rides on every path.
 */
export function prependResultNotice<TDetails>(
	result: AgentToolResult<TDetails>,
	notice: string,
): AgentToolResult<TDetails> {
	const content = [...result.content];
	const firstText = content.findIndex(block => block.type === "text");
	if (firstText >= 0) {
		const block = content[firstText] as TextContent;
		content[firstText] = { ...block, text: `${notice}\n\n${block.text}` };
	} else {
		content.unshift({ type: "text", text: notice });
	}
	return { ...result, content };
}
