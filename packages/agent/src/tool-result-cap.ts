import type { ImageContent, TextContent } from "@veyyon/ai";
import { capTextBytes, elisionMarker, logger } from "@veyyon/utils";

/** Backstop cap on the bytes a single tool result may contribute to the request. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Warned-about tools, so an unbounded tool logs once rather than every call. */
const reportedTools = new Set<string>();

/** Reset the once-per-tool report state. Tests only. */
export function __resetToolResultCapReportsForTests(): void {
	reportedTools.clear();
}

/** Outcome of {@link capToolResultContent}. */
export interface ToolResultCapResult {
	/** The content to send. The same array instance when nothing was capped. */
	content: (TextContent | ImageContent)[];
	/** Total text bytes before capping. */
	originalBytes: number;
	/** Total bytes elided. `0` when the result already fit. */
	elidedBytes: number;
}

/** Cap the text a tool result contributes to the next request. */
export function capToolResultContent(
	content: (TextContent | ImageContent)[],
	toolName: string,
	maxBytes: number = DEFAULT_TOOL_RESULT_MAX_BYTES,
): ToolResultCapResult {
	let originalBytes = 0;
	for (const block of content) {
		if (block.type === "text") originalBytes += Buffer.byteLength(block.text, "utf-8");
	}
	if (maxBytes <= 0 || originalBytes <= maxBytes) return { content, originalBytes, elidedBytes: 0 };

	const capped: (TextContent | ImageContent)[] = [];
	let elidedBytes = 0;
	for (const block of content) {
		if (block.type !== "text") {
			capped.push(block);
			continue;
		}
		const blockBytes = Buffer.byteLength(block.text, "utf-8");
		// Proportional share, so the split does not depend on block order.
		const share = Math.floor((blockBytes / originalBytes) * maxBytes);
		const result = capTextBytes(block.text, share);
		// For a small enough block the marker costs more than the bytes it
		// replaces, and capping would GROW the result. Keep the original then:
		// a cap that makes the request bigger is worse than no cap at all.
		if (Buffer.byteLength(result.text, "utf-8") >= blockBytes) {
			capped.push(block);
			continue;
		}
		elidedBytes += result.elidedBytes;
		capped.push({ ...block, text: result.text });
	}

	reportCappedToolResult(toolName, originalBytes, elidedBytes, maxBytes);
	return { content: capped, originalBytes, elidedBytes };
}

/** Say, once per tool, that a result was cut down before it was sent. */
function reportCappedToolResult(toolName: string, originalBytes: number, elidedBytes: number, maxBytes: number): void {
	const detail = { tool: toolName, originalBytes, elidedBytes, maxBytes };
	if (reportedTools.has(toolName)) {
		logger.debug("tool result capped again", detail);
		return;
	}
	reportedTools.add(toolName);
	logger.warn(
		`tool "${toolName}" returned ${originalBytes} bytes, over the ${maxBytes} byte request budget, so ${elidedBytes} bytes were elided from the middle of its result and the model will not see them`,
		detail,
	);
}

/** The marker written where bytes were removed. See {@link capTextBytes}. */
export { elisionMarker };
