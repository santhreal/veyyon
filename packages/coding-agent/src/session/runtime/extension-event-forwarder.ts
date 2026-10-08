/**
 * Forwards session events to the extension runner as the extension event each one maps to, and
 * counts the turns of the current run for the `turn_start` / `turn_end` hooks.
 *
 * This is a session collaborator. It holds the turn index and the tail of the queue that keeps
 * streamed `message_update` events in order, and never touches the session.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type {
	ExtensionRunner,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../../extensibility/extensions";
import type { AgentSessionEvent } from "../agent-session-types";

export class ExtensionEventForwarder {
	readonly #runner: ExtensionRunner | undefined;
	#turnIndex = 0;
	#queueTail: Promise<void> = Promise.resolve();

	constructor(runner: ExtensionRunner | undefined) {
		this.#runner = runner;
	}

	/** Index of the turn the run is on: reset by `agent_start`, advanced after each `turn_end`. */
	get turnIndex(): number {
		return this.#turnIndex;
	}

	/**
	 * Forward `event` after every event enqueued before it. The returned promise carries this event's
	 * failure; the queue itself never rejects, so one extension throwing does not stall later events.
	 */
	enqueue(event: AgentSessionEvent): Promise<void> {
		const forward = () => this.forward(event);
		const queued = this.#queueTail.then(forward, forward);
		this.#queueTail = queued.catch(() => {});
		return queued;
	}

	/**
	 * The settled `agent_end` notification. Sent from the session's agent_end maintenance path rather
	 * than from {@link forward}, so `session_stop` control hooks are not blocked behind
	 * notification-only work.
	 */
	async agentEnd(messages: AgentMessage[]): Promise<void> {
		await this.#runner?.emit({ type: "agent_end", messages });
	}

	/** Forward one session event to the extension runner, if it has a handler for the event type. */
	async forward(event: AgentSessionEvent): Promise<void> {
		const runner = this.#runner;
		if (!runner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await runner.emit({ type: "agent_start" });
			return;
		}

		if (!runner.hasHandlers(event.type)) return;
		if (event.type === "agent_end") {
			// See {@link agentEnd}.
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await runner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await runner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await runner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await runner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await runner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await runner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				errorId: event.errorId,
				mode: event.mode,
			});
		} else if (event.type === "auto_retry_end") {
			await runner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				mode: event.mode,
				recoveredErrors: event.recoveredErrors,
			});
		} else if (event.type === "ttsr_triggered") {
			await runner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await runner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		} else if (event.type === "goal_updated") {
			await runner.emit({
				type: "goal_updated",
				goal: event.goal,
				state: event.state,
			});
		}
	}
}
