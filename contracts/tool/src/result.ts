import type { ImageContent, TextContent } from "@veyyon/model";

export interface ToolResult<TDetails = unknown> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details?: TDetails;
	// Marks a non-throwing failure (e.g. an aggregator catching per-entry errors).
	// agent-loop honors this and surfaces it as a tool error on the wire.
	isError?: boolean;
	/** Marks the result as contextually useless: safe for compaction to elide once consumed (e.g. zero matches, wait timeout). Ignored when isError is set. */
	useless?: boolean;
}

// Callback for streaming tool execution updates
export type ToolUpdateCallback<TDetails = unknown> = (partialResult: ToolResult<TDetails>) => void;
