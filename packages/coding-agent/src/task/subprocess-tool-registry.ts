/**
 * Registry for handling tool events from subprocess agents.
 *
 * Tools can register handlers to:
 * - Extract structured data from their execution results
 * - Trigger subprocess termination on completion
 */
import { TOOL } from "../tools/core/builtin-names";

/**
 * The tool a spawned agent uses to return its result, by name.
 *
 * It lives here rather than in `tools/agent/yield.ts` because the name is part of the SUBPROCESS
 * PROTOCOL, not just a tool's label: a `tool_execution_end` carrying it is how the executor learns
 * an agent is finished, the reminder loop forces a named tool_choice with it, and the renderer
 * gives its extracted data a section of its own. All three read it, and the tool module cannot be
 * their source: `task/render.ts` and `task/renderer.ts` are deliberately importable WITHOUT loading
 * a tool (see the header of `renderer.ts`), and `tools/index.ts` dynamic-imports every tool factory
 * to keep startup work off the critical path.
 *
 * The literal used to be written out in sixteen places across eight files, so a rename would have
 * compiled and quietly stopped an agent's result from being recognised.
 *
 * NOT the `"yield"` VALUE of the `agent.output` setting (`settings-domains/providers.ts`), which
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
	 * A tool's accumulated data is drawn by the block that owns it, never by a handler.
	 *
	 * Two rendering members used to sit here, `renderInline` and `renderFinal`, and no reader could
	 * reach either: every caller draws a tool's rows through the card that owns them, and each of the
	 * three registered handlers is skipped by name before the lookup that would have found it. They
	 * were terminal drawing typed into the subprocess protocol, which is why removing them is what
	 * takes the last terminal type out of this module.
	 */
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
