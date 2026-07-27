/**
 * Registry for handling tool events from subprocess agents.
 *
 * Tools can register handlers to:
 * - Extract structured data from their execution results
 * - Trigger subprocess termination on completion
 * - Provide custom rendering for realtime/final display
 */
import type { Component } from "@veyyon/tui";
import type { Theme } from "../modes/theme/theme";
import { TOOL } from "../tools/builtin-names";

/**
 * The tool a spawned agent uses to return its result, by name.
 *
 * It lives here rather than in `tools/yield.ts` because the name is part of the SUBPROCESS
 * PROTOCOL, not just a tool's label: a `tool_execution_end` carrying it is how the executor learns
 * a subagent is finished, the reminder loop forces a named tool_choice with it, and the renderer
 * gives its extracted data a section of its own. All three read it, and the tool module cannot be
 * their source: `task/render.ts` and `task/renderer.ts` are deliberately importable WITHOUT loading
 * a tool (see the header of `renderer.ts`), and `tools/index.ts` dynamic-imports every tool factory
 * to keep startup work off the critical path.
 *
 * The literal used to be written out in sixteen places across eight files, so a rename would have
 * compiled and quietly stopped a subagent's result from being recognised.
 *
 * NOT the `"yield"` VALUE of the `subagent.output` setting (`settings-domains/providers.ts`), which
 * selects "final message only". Different question, same word.
 */
export const YIELD_TOOL_NAME = TOOL.yield;

/** Event from subprocess tool execution (parsed from JSONL) */
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

/** Handler for subprocess tool events */
export interface SubprocessToolHandler<TData = unknown> {
	/**
	 * Extract structured data from tool result.
	 * Extracted data is accumulated in progress.extractedToolData[toolName][].
	 */
	extractData?: (event: SubprocessToolEvent) => TData | undefined;

	/**
	 * Whether this tool's completion should terminate the subprocess.
	 * Return true to send SIGTERM after the tool completes.
	 */
	shouldTerminate?: (event: SubprocessToolEvent) => boolean;

	/**
	 * Render a single data item inline during streaming progress.
	 * Called for each tool execution end event.
	 */
	renderInline?: (data: TData, theme: Theme) => Component;

	/**
	 * Render accumulated data in the final result view.
	 * Called once with all accumulated data for this tool.
	 */
	renderFinal?: (allData: TData[], theme: Theme, expanded: boolean) => Component;
}

/** Registry for subprocess tool handlers */
class SubprocessToolRegistryImpl {
	#handlers = new Map<string, SubprocessToolHandler>();

	/**
	 * Register a handler for a tool's subprocess events.
	 */
	register<T>(toolName: string, handler: SubprocessToolHandler<T>): void {
		this.#handlers.set(toolName, handler as SubprocessToolHandler);
	}

	/**
	 * Get the handler for a tool, if registered.
	 */
	getHandler(toolName: string): SubprocessToolHandler | undefined {
		return this.#handlers.get(toolName);
	}

	/**
	 * Check if a tool has a registered handler.
	 */
	hasHandler(toolName: string): boolean {
		return this.#handlers.has(toolName);
	}

	/**
	 * Get all registered tool names.
	 */
	getRegisteredTools(): string[] {
		return Array.from(this.#handlers.keys());
	}
}

/** Singleton registry instance */
export const subprocessToolRegistry = new SubprocessToolRegistryImpl();

/** Type helper for extracted tool data in progress/result */
export type ExtractedToolData = Record<string, unknown[]>;
