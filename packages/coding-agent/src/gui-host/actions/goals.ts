import { attachGoalBridge } from "../goal-bridge";
import { getOrCreateAgentSession } from "../turns";
import type { GoalControl } from "../wire";
import { activateSession, replyError } from "./active-session";
import type { ActionHandler, ActionHandlersMap } from "./types";

interface SetGoalPayload {
	session?: string;
	objective?: string;
	token_budget?: number | null;
}

interface ControlGoalPayload {
	session?: string;
	op?: GoalControl;
}

const handleSetGoal: ActionHandler<SetGoalPayload | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "SetGoal requires a session identifier",
			retryable: false,
		});
		return;
	}
	const objective = payload.objective?.trim();
	if (!objective) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "SetGoal requires a non-empty objective",
			retryable: false,
		});
		return;
	}

	try {
		if (!(await activateSession(ctx, payload.session))) return;
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);

		if (!session.settings.get("goal.enabled")) {
			ctx.reply.failure({
				scope: "Session",
				code: "MODE_DISABLED",
				message: "Goal mode is disabled. Enable it in settings (goal.enabled).",
				retryable: false,
			});
			return;
		}

		const driver = await attachGoalBridge(session, ctx.clientState, ctx.socket);
		// The rule about which modes block a goal is the driver's, so it is asked rather than
		// restated here; the window needs the refusal typed, which is all this adds to it.
		const blocking = ctx.clientState.goalBridge?.blockingMode();
		if (blocking) {
			ctx.reply.failure({
				scope: "Session",
				code: "MODE_CONFLICT",
				message: `Exit ${blocking} mode first.`,
				retryable: false,
			});
			return;
		}

		const tokenBudget = typeof payload.token_budget === "number" ? payload.token_budget : undefined;

		if (driver.enabled) {
			await driver.replaceGoal({ objective, tokenBudget });
		} else {
			await driver.enter({ objective, tokenBudget });
		}
		driver.scheduleContinuation();
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "SET_GOAL_FAILED", error);
	}
};

const handleControlGoal: ActionHandler<ControlGoalPayload | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "ControlGoal requires a session identifier",
			retryable: false,
		});
		return;
	}
	const op = payload.op;
	if (!op || !["pause", "resume", "drop"].includes(op)) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "ControlGoal op must be one of pause, resume, drop",
			retryable: false,
		});
		return;
	}

	try {
		if (!(await activateSession(ctx, payload.session))) return;
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		const driver = await attachGoalBridge(session, ctx.clientState, ctx.socket);
		const state = session.getGoalModeState();
		const goal = state?.goal;

		if (!goal) {
			ctx.reply.failure({
				scope: "Session",
				code: "NO_GOAL",
				message: "The session has no goal to control. Set a goal first with SetGoal or /goal <objective>.",
				retryable: false,
			});
			return;
		}

		if (op === "resume" && goal.status === "dropped") {
			ctx.reply.failure({
				scope: "Session",
				code: "GOAL_DROPPED",
				message: "Cannot resume a dropped goal. Set a new goal instead with SetGoal or /goal <objective>.",
				retryable: false,
			});
			return;
		}

		if (op === "pause") {
			if (!driver.enabled && goal.status === "paused") {
				ctx.reply.success();
				return;
			}
			await driver.pause();
			ctx.reply.success();
			return;
		}

		if (op === "resume") {
			if (!session.settings.get("goal.enabled")) {
				ctx.reply.failure({
					scope: "Session",
					code: "MODE_DISABLED",
					message: "Goal mode is disabled. Enable it in settings (goal.enabled).",
					retryable: false,
				});
				return;
			}
			if (session.getPlanModeState()?.enabled) {
				ctx.reply.failure({
					scope: "Session",
					code: "MODE_CONFLICT",
					message: "Exit plan mode first.",
					retryable: false,
				});
				return;
			}
			if (session.getVibeModeState()?.enabled) {
				ctx.reply.failure({
					scope: "Session",
					code: "MODE_CONFLICT",
					message: "Exit vibe mode first.",
					retryable: false,
				});
				return;
			}
			await driver.resume();
			ctx.reply.success();
			return;
		}

		if (op === "drop") {
			await driver.drop();
			ctx.reply.success();
			return;
		}
	} catch (error) {
		replyError(ctx, "CONTROL_GOAL_FAILED", error);
	}
};

export const goalActionHandlers: ActionHandlersMap = {
	SetGoal: handleSetGoal as ActionHandler<never>,
	ControlGoal: handleControlGoal as ActionHandler<never>,
};
