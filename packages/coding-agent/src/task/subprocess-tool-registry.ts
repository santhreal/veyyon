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

class SubprocessToolRegistryImpl {
	#handlers = new Map<string, SubprocessToolHandler>();

	register<T>(toolName: string, handler: SubprocessToolHandler<T>): void {
		this.#handlers.set(toolName, handler as SubprocessToolHandler);
	}

	getHandler(toolName: string): SubprocessToolHandler | undefined {
		return this.#handlers.get(toolName);
	}

	hasHandler(toolName: string): boolean {
		return this.#handlers.has(toolName);
	}

	getRegisteredTools(): string[] {
		return Array.from(this.#handlers.keys());
	}
}

export const subprocessToolRegistry = new SubprocessToolRegistryImpl();
