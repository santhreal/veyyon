/** Auto-learn session controller (experimental). Subscribes to the session event stream and, after a substantive turn, */
import { logger } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import { autolearnPrompts } from "../prompts/autolearn/rows";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnPrompts["autolearn/nudge-autocontinue"].text.trim();
const DEFAULT_MIN_TOOL_CALLS = 5;

/** Build the standing auto-learn guidance for the system prompt from the tools actually present in the active set, or null when `manage_skill` is absent. */
export function buildAutoLearnInstructions(available: { manageSkill: boolean; learn: boolean }): string | null {
	if (!available.manageSkill) return null;
	const parts = [autolearnPrompts["autolearn/guidance"].text.trim()];
	if (available.learn) parts.push(autolearnPrompts["autolearn/guidance-learn"].text.trim());
	return parts.join("\n\n");
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	#toolCalls = 0;
	/** Whether the in-flight turn BEGAN while goal mode was active. Captured at agent_start because a `goal` tool can complete or drop the goal mid-turn, */
	#turnStartedInGoalMode = false;
	/** Swallow the agent_end produced by an auto-run capture turn so it cannot re-trigger. */
	#suppressNext = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		// The listener closure captures `this`, so the session's listener array
		// keeps the controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			// Capture goal-mode state at the turn boundary, before any tool runs.
			this.#turnStartedInGoalMode = this.#session.getGoalModeState()?.enabled === true;
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// Snapshot and reset every turn: the counter describes only the
		// just-finished turn, so below-threshold, disabled, and plan-mode stops
		// must not let tool calls accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		// Snapshot the turn-start goal flag alongside the counter so a turn that
		// observed no agent_start can never inherit a stale value.
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		if (this.#suppressNext) {
			this.#suppressNext = false;
			return;
		}
		// Never nudge a turn that ended in an abort (ESC, cancel, etc.). The
		// abort flag on the session is unreliable by the time agent_end is
		// deferred to subscribers; read stopReason from the event messages.
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				if ("stopReason" in message && message.stopReason === "aborted") {
					return;
				}
				break;
			}
		}
		// Honor a live opt-out: the subscription outlives the setting, so re-check
		// the current flag rather than trusting install-time state.
		if (!this.#settings.get("autolearn.enabled")) return;
		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_MIN_TOOL_CALLS;
		if (toolCalls < minToolCalls) return;
		// Never interrupt plan-mode review.
		if (this.#session.getPlanModeState()?.enabled) return;
		// Never divert a goal loop. Skip when the turn STARTED in goal mode — a `goal` tool may have completed/dropped the goal before this stop — or is
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		// Auto-run a capture turn only when explicitly enabled. Passive mode used to queue a hidden custom message for the next real turn, but that mutates the
		const autoContinue = this.#settings.get("autolearn.autoContinue") === true;
		if (!autoContinue) return;

		const content = AUTOLEARN_NUDGE_AUTOCONTINUE;
		// Arm suppression synchronously: the synthetic capture turn's agent_end fires inside sendCustomMessage (before it resolves), so the flag must be
		this.#suppressNext = true;

		this.#session
			.sendCustomMessage(
				{
					customType: "autolearn-nudge",
					content,
					display: false,
					attribution: "user",
				},
				{ deliverAs: "nextTurn", triggerTurn: true, acceptTerminalEmptyStop: true },
			)
			.then(started => {
				if (!started) this.#suppressNext = false;
			})
			.catch(err => {
				this.#suppressNext = false;
				logger.warn("auto-learn nudge delivery failed", { err });
			});
	}
}
