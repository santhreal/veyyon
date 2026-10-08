/**
 * Stop retries: the empty-stop and unexpected-stop recovery cycles.
 *
 * This is a session collaborator. It holds the two retry counters, the developer reminders the cycle
 * in flight appended, and the per-prompt flag that accepts a terminal empty stop, and reaches the
 * session only through {@link StopRetriesHost}.
 *
 * - **Empty stop** ({@link StopRetries.onEmptyStop}): an assistant turn with nothing in it is dropped
 *   and retried with a reminder, up to {@link EMPTY_STOP_MAX_RETRIES} times. At the cap the turn is
 *   dropped and the retry ladder reports the failure. A prompt that accepts a terminal empty stop
 *   ends on its first one instead, with the stop and the custom prompt that produced it pruned.
 * - **Unexpected stop** ({@link StopRetries.onUnexpectedStop}): a reply the classifier reads as
 *   announcing an action it never took is continued with a reminder, up to
 *   {@link UNEXPECTED_STOP_MAX_RETRIES} times.
 *
 * The reminders describe the turn the cycle is retrying. They leave the active context when a cycle
 * gives up and when the next prompt starts, so no later turn reads instructions about a turn that no
 * longer exists.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { assistantText } from "@veyyon/ai/utils/message-text";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { mayContinueAtSettle, type SettleContinuationState } from "@veyyon/kernel/session/settle-continuation";
import { logger, prompt } from "@veyyon/utils";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import { isEmptyAssistantStop, isSameAssistantMessage } from "../agent-session-message-shapes";
import type { ScheduledAgentContinueOptions } from "../agent-session-types";
import { isUnexpectedStopCandidate } from "../unexpected-stop-classifier";

/** Empty-stop retries a cycle makes before it gives up. */
export const EMPTY_STOP_MAX_RETRIES = 3;
/** Unexpected-stop continuations a cycle makes before it gives up. */
export const UNEXPECTED_STOP_MAX_RETRIES = 3;
/** How long the unexpected-stop classifier runs before its answer is ignored. */
export const UNEXPECTED_STOP_TIMEOUT_MS = 4000;

/** The agent slice the cycles drive. `Agent` satisfies this structurally. */
export interface StopRetriesAgent {
	readonly state: { readonly messages: readonly AgentMessage[] };
	appendMessage(message: AgentMessage): void;
	replaceMessages(messages: AgentMessage[]): void;
}

/** The session log slice an accepted terminal empty stop is pruned from. `SessionManager` satisfies this. */
export interface StopRetriesStore {
	getBranch(): readonly SessionEntry[];
	branch(branchFromId: string): void;
	resetLeaf(): void;
	appendCustomEntry(customType: string, data?: unknown): string;
}

/** What {@link StopRetries} needs from the session that holds it. */
export interface StopRetriesHost {
	readonly agent: StopRetriesAgent;
	readonly sessionStore: StopRetriesStore;
	/** Whether `features.unexpectedStopDetection` is on; read at every settle. */
	unexpectedStopDetection(): boolean;
	/** Whether the reply announces an action it never took. `undefined` when no classifier answered. */
	classifyUnexpectedStop(text: string, signal: AbortSignal): Promise<boolean | undefined>;
	/** Prompt generation a scheduled retry must still match to run. */
	promptGeneration(): number;
	scheduleAgentContinue(options: ScheduledAgentContinueOptions): void;
	/** Drop an assistant turn from the live context and the persisted branch. */
	discardAssistantTurn(message: AssistantMessage): void;
	/** Drop an assistant turn, and the never-ran tool results after it, from the live context only. */
	removeAssistantFromActiveContext(message: AssistantMessage, reason: string): void;
	/** Close a continuation wait the retry ladder announced, reporting `finalError`. */
	endAnnouncedContinuationWait(finalError: string): Promise<void>;
	/** Report an empty-stop cycle that reached its cap after `attempts` retries. */
	failAtEmptyStopCap(attempts: number, finalError: string): Promise<void>;
}

export class StopRetries {
	readonly #host: StopRetriesHost;
	#emptyStops = 0;
	#unexpectedStops = 0;
	/**
	 * Developer reminders the cycle in flight appended, in append order. Removed by identity rather
	 * than by text: the body is rendered from a prompt file, and matching on those bytes would also
	 * remove an unrelated developer message that quotes them.
	 */
	#reminders: AgentMessage[] = [];
	/** Set for a prompt whose empty `stop` ends it instead of retrying; the first such stop clears it. */
	acceptTerminalEmptyStop = false;

	constructor(host: StopRetriesHost) {
		this.#host = host;
	}

	/** Start a prompt with both budgets full, no reminders in context, and terminal empty stops retried. */
	resetForPrompt(): void {
		this.#emptyStops = 0;
		this.#unexpectedStops = 0;
		this.#dropReminders();
		this.acceptTerminalEmptyStop = false;
	}

	/** Handle an empty assistant stop. Returns true when a retry was scheduled. */
	async onEmptyStop(message: AssistantMessage): Promise<boolean> {
		if (!isEmptyAssistantStop(message)) {
			this.#emptyStops = 0;
			return false;
		}
		const host = this.#host;
		if (this.acceptTerminalEmptyStop && message.stopReason === "stop") {
			this.acceptTerminalEmptyStop = false;
			this.#discardAcceptedTerminalEmptyStop(message);
			this.#emptyStops = 0;
			// This prompt is over, so a continuation's announced wait has no later turn to close it.
			// Nothing recovered, which is what the end reports.
			await host.endAnnouncedContinuationWait("Continued turn returned an empty completion");
			return false;
		}

		this.#emptyStops++;
		if (this.#emptyStops > EMPTY_STOP_MAX_RETRIES) {
			const attempts = this.#emptyStops - 1;
			const failure = "Assistant returned empty stop after retry cap";
			logger.warn(failure, { attempts, model: message.model, provider: message.provider });
			// The operator-facing line states the model: an empty completion is a property of the
			// model behind the turn, and switching models is the recovery left to the user.
			await host.failAtEmptyStopCap(attempts, `${failure} (${message.provider}/${message.model})`);
			// The budget belongs to the next turn. A count left above the cap makes the next turn that
			// does not run the per-prompt reset (a maintenance nudge, an IRC wake, a queued follow-up)
			// cap on its first empty stop with zero retries and report attempts it never made.
			this.#emptyStops = 0;
			// Nothing this turn produced is kept. An empty assistant turn replays on reload and re-sends
			// the context that produced it; a toolUse stop with no tool_use block also corrupts
			// Anthropic history, where a later tool_result has nothing to anchor to. The reminders
			// describe the discarded turn.
			host.discardAssistantTurn(message);
			this.#dropReminders();
			return false;
		}
		host.discardAssistantTurn(message);
		this.#retryWith(
			prompt.render(turnControlPrompts["turn-control/empty-stop-retry"].text, {
				retryCount: this.#emptyStops,
				maxRetries: EMPTY_STOP_MAX_RETRIES,
			}),
		);
		return true;
	}

	/** Handle a reply that may have stopped short of an action it announced. Returns true when continued. */
	async onUnexpectedStop(message: AssistantMessage, settleState: SettleContinuationState): Promise<boolean> {
		const host = this.#host;
		if (!host.unexpectedStopDetection()) return false;
		// Checked before the classifier: a reply that hands the turn back to the user is the shape the
		// classifier most readily reads as an announced action, so asking spends a model call to be
		// told the opposite of what the reply says. The budget resets: the user is in the loop and the
		// next turn starts with its full runway.
		if (!mayContinueAtSettle("unexpected-stop-retry", settleState) || !isUnexpectedStopCandidate(message)) {
			this.#unexpectedStops = 0;
			return false;
		}
		const text = assistantText(message);
		if (!/\S/.test(text)) {
			this.#unexpectedStops = 0;
			return false;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), UNEXPECTED_STOP_TIMEOUT_MS);
		let classification: boolean | undefined;
		try {
			classification = await host.classifyUnexpectedStop(text, controller.signal);
		} finally {
			clearTimeout(timeout);
		}
		if (classification !== true) {
			this.#unexpectedStops = 0;
			return false;
		}

		this.#unexpectedStops++;
		if (this.#unexpectedStops > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStops - 1,
				model: message.model,
				provider: message.provider,
			});
			this.#unexpectedStops = 0;
			// As at the empty-stop cap: the reminders tell the model to finish a turn this cycle has
			// stopped trying to finish.
			this.#dropReminders();
			return false;
		}
		this.#retryWith(
			prompt.render(turnControlPrompts["turn-control/unexpected-stop-retry"].text, {
				retryCount: this.#unexpectedStops,
				maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
			}),
		);
		return true;
	}

	/** Append a cycle reminder to the live context and schedule the retry that reads it. */
	#retryWith(text: string): void {
		const reminder: AgentMessage = {
			role: "developer",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#reminders.push(reminder);
		this.#host.agent.appendMessage(reminder);
		this.#host.scheduleAgentContinue({ generation: this.#host.promptGeneration() });
	}

	#dropReminders(): void {
		if (this.#reminders.length === 0) return;
		const scaffolding = new Set<AgentMessage>(this.#reminders);
		this.#reminders = [];
		const agent = this.#host.agent;
		const messages = agent.state.messages;
		const kept = messages.filter(message => !scaffolding.has(message));
		if (kept.length !== messages.length) agent.replaceMessages(kept);
	}

	/**
	 * Remove an accepted terminal empty stop from the live context and the session branch. When the
	 * stop answered a custom prompt, that prompt goes too, and the branch moves to the entry before it.
	 */
	#discardAcceptedTerminalEmptyStop(message: AssistantMessage): void {
		const host = this.#host;
		const store = host.sessionStore;
		const branch = store.getBranch();
		const branchEntry = branch.findLast(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				isSameAssistantMessage(entry.message, message),
		);
		const parentEntry =
			branchEntry?.parentId === null || branchEntry?.parentId === undefined
				? undefined
				: branch.find(entry => entry.id === branchEntry.parentId);
		const prunePrompt = parentEntry?.type === "custom_message";

		host.removeAssistantFromActiveContext(message, "accepted-terminal-empty-stop");
		const messages = host.agent.state.messages;
		if (prunePrompt && messages.at(-1)?.role === "custom") {
			host.agent.replaceMessages(messages.slice(0, -1));
		}

		if (!branchEntry) return;
		const targetParentId = prunePrompt ? parentEntry.parentId : branchEntry.parentId;
		if (targetParentId === null) {
			store.resetLeaf();
		} else {
			store.branch(targetParentId);
		}
		store.appendCustomEntry("accepted-terminal-empty-stop");
	}
}
