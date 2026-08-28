import { logger } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import { autolearnPrompts } from "../prompts/autolearn/rows";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnPrompts["autolearn/nudge-autocontinue"].text.trim();
const DEFAULT_MIN_TOOL_CALLS = 5;

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
	#turnStartedInGoalMode = false;
	#suppressNext = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
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
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		if (this.#suppressNext) {
			this.#suppressNext = false;
			return;
		}
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				if ("stopReason" in message && message.stopReason === "aborted") {
					return;
				}
				break;
			}
		}
		if (!this.#settings.get("autolearn.enabled")) return;
		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_MIN_TOOL_CALLS;
		if (toolCalls < minToolCalls) return;
		if (this.#session.getPlanModeState()?.enabled) return;
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		const autoContinue = this.#settings.get("autolearn.autoContinue") === true;
		if (!autoContinue) return;

		const content = AUTOLEARN_NUDGE_AUTOCONTINUE;
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
