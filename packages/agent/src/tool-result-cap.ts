import type { ImageContent, TextContent } from "@veyyon/ai";
import { capTextBytes, elisionMarker, logger } from "@veyyon/utils";

export const DEFAULT_TOOL_RESULT_MAX_BYTES = 1024 * 1024; // 1 MiB

const reportedTools = new Set<string>();

export function __resetToolResultCapReportsForTests(): void {
	reportedTools.clear();
}

export interface ToolResultCapResult {
	content: (TextContent | ImageContent)[];
	originalBytes: number;
	elidedBytes: number;
}

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
		const share = Math.floor((blockBytes / originalBytes) * maxBytes);
		const result = capTextBytes(block.text, share);
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

export { elisionMarker };
