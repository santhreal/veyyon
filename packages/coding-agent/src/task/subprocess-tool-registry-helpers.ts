import type { Component } from "@veyyon/tui";
import type { Theme } from "../modes/theme/theme";
import { TOOL } from "../tools/builtin-names";

export const YIELD_TOOL_NAME = TOOL.yield;

export interface SubprocessToolEvent {
	toolName: string;
	toolCallId: string;
	args?: Record<string, unknown>;
	result?: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	};
	isError?: boolean;
}

export interface SubprocessToolHandler<TData = unknown> {
	extractData?: (event: SubprocessToolEvent) => TData | undefined;

	shouldTerminate?: (event: SubprocessToolEvent) => boolean;

	renderInline?: (data: TData, theme: Theme) => Component;

	renderFinal?: (allData: TData[], theme: Theme, expanded: boolean) => Component;
}
