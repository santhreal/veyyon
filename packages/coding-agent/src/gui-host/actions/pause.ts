import { agentPauseGate } from "@veyyon/agent-core";
import type { AgentPauseView } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

/**
 * The freeze the desktop's `/pause` engages, which is the terminal's.
 *
 * Both hosts drive one process-global gate, so a pause engaged from a
 * terminal running beside a window reaches the window, and a pause the window
 * engaged freezes the terminal's agents too. Nothing is aborted: every loop
 * parks at its next action boundary, in-flight streams and started tools run
 * to completion, and queued prompts stay queued.
 */
export function agentPauseSection(): AgentPauseView {
	return { paused: agentPauseGate.paused, since_ms: agentPauseGate.pausedAt ?? null };
}

/**
 * Engage the freeze, refusing when one is already engaged.
 *
 * The gate answers false rather than stacking, and two windows are two
 * presses: without the refusal the second press would report success and the
 * operator would expect a second release to be needed.
 */
const handlePauseAgents: ActionHandler = ctx => {
	if (!agentPauseGate.pause()) {
		ctx.reply.failure({
			scope: "Connection",
			code: "ALREADY_PAUSED",
			message: "Every agent is already frozen.",
			retryable: false,
		});
		return;
	}
	ctx.reply.success();
};

/** Release the freeze, refusing when nothing is frozen. */
const handleResumeAgents: ActionHandler = ctx => {
	if (agentPauseGate.resume() === undefined) {
		ctx.reply.failure({
			scope: "Connection",
			code: "NOTHING_PAUSED",
			message: "No agent is frozen.",
			retryable: false,
		});
		return;
	}
	ctx.reply.success();
};

export const pauseActionHandlers: ActionHandlersMap = {
	PauseAgents: handlePauseAgents as ActionHandler<never>,
	ResumeAgents: handleResumeAgents as ActionHandler<never>,
};
