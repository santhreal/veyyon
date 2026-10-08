/**
 * Terminal `yield` tracking: which `yield` call ended the run, and whether the run is terminal.
 *
 * A successful `yield` is the run's terminal result. The session aborts the run as soon as one lands,
 * and a stop that settles after it in the same prompt cycle (an empty or aborted trailing assistant
 * message) starts no empty-stop retry, unexpected-stop retry, queued-message drain or compaction
 * continuation.
 *
 * This is a session collaborator with no host. The session reports each tool result and aborts the
 * run when a report returns `true`, and reads and clears the recorded call when a run settles.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import { TOOL } from "../../tools/core/builtin-names";

/** The fields of a tool result that decide whether it ended the run. */
export interface YieldToolResult {
	toolName: string;
	isError?: boolean;
	result?: { details?: unknown };
}

export class YieldTracker {
	/** The `yield` call that ended the run, until a settle clears it. */
	#toolCallId: string | undefined;
	/** Set by a terminal `yield`; cleared when the next prompt starts. */
	#terminationPending = false;
	/** `yield` calls `afterToolCall` handled, so their execution end does not report them again. */
	readonly #handledAfterCall = new Set<string>();

	/** Whether a terminal `yield` landed since the current prompt started. */
	get terminationPending(): boolean {
		return this.#terminationPending;
	}

	/** A new prompt starts: the run is no longer terminal. */
	resetForPrompt(): void {
		this.#terminationPending = false;
	}

	/** `afterToolCall` saw `result` for `toolCallId`. `true` when it ended the run and the caller must abort. */
	noteAfterToolCall(toolCallId: string, result: YieldToolResult): boolean {
		if (!isTerminalYieldToolResult(result)) return false;
		this.#mark(toolCallId);
		this.#handledAfterCall.add(toolCallId);
		return true;
	}

	/**
	 * A tool execution ended. `true` when it is a terminal `yield` `afterToolCall` did not already
	 * report, and the caller must abort.
	 */
	noteExecutionEnd(event: YieldToolResult & { toolCallId: string }): boolean {
		if (!isTerminalYieldToolResult(event) || this.#handledAfterCall.delete(event.toolCallId)) return false;
		this.#mark(event.toolCallId);
		return true;
	}

	/** The newest message in `messages` whose last tool call is the recorded `yield`. */
	findYieldMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		const toolCallId = this.#toolCallId;
		if (!toolCallId) return undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			if (lastCallIsYield(message, toolCallId)) return message;
		}
		return undefined;
	}

	/** Whether the last tool call of `message` is the recorded `yield`. */
	endedWithYield(message: AssistantMessage): boolean {
		const toolCallId = this.#toolCallId;
		return toolCallId ? lastCallIsYield(message, toolCallId) : false;
	}

	/** Forget the recorded `yield` call. */
	clear(): void {
		this.#toolCallId = undefined;
	}

	#mark(toolCallId: string): void {
		this.#toolCallId = toolCallId;
		this.#terminationPending = true;
	}
}

/**
 * Whether a tool result ends the run: a `yield` that did not fail, unless its details hold
 * `status: "success"` with a non-empty `type` list of strings.
 */
function isTerminalYieldToolResult(event: YieldToolResult): boolean {
	if (event.toolName !== TOOL.yield || event.isError) return false;
	const details = event.result?.details;
	if (!details || typeof details !== "object") return true;
	const record = details as Record<string, unknown>;
	return !(
		record.status === "success" &&
		Array.isArray(record.type) &&
		record.type.length > 0 &&
		record.type.every(item => typeof item === "string")
	);
}

function lastCallIsYield(message: AssistantMessage, toolCallId: string): boolean {
	const lastToolCall = message.content.findLast((content): content is ToolCall => content.type === "toolCall");
	return lastToolCall?.name === TOOL.yield && lastToolCall.id === toolCallId;
}
