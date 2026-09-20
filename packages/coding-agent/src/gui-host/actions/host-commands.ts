/**
 * The commands the host answers itself, run for the window that asked.
 *
 * A command reaches here only when `desktop-commands.ts` lists it, so the
 * catalogue a window draws and the set this dispatch answers are the same
 * declarations. A handler either answers the request or fails it; throwing is
 * how it reports a failure the caller should state as one.
 */
import { parseGoalSubcommand } from "../../goals/subcommands";
import type { AgentSession } from "../../session/agent-session";
import type { DesktopHostCommandName } from "../desktop-commands";
import { attachGoalBridge } from "../goal-bridge";
import { goalSection } from "../goal-view";
import { answerSideQuestion } from "../side-question";
import type { ActionContext } from "./types";

type HostCommand = (ctx: ActionContext, session: AgentSession, args: string) => Promise<void>;

/**
 * `/btw`: a question answered from the session's context, beside the work.
 *
 * The answer is awaited, so the request completes when the answer is whole.
 * A window that drew a spinner for the request stops it on the reply rather
 * than guessing when the streamed entry stopped growing.
 */
const btw: HostCommand = async (ctx, session, args) => {
	const question = args.trim();
	if (!question) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "Usage: /btw <question>",
			retryable: false,
		});
		return;
	}
	await answerSideQuestion(ctx.socket, ctx.clientState, session, question);
	ctx.reply.success();
};

/**
 * `/goal`: manage goal mode from the desktop command palette.
 * Handles `/goal <objective>`, `/goal pause`, `/goal resume`, `/goal drop`, and `/goal show`.
 */
const goal: HostCommand = async (ctx, session, args) => {
	if (!session.settings.get("goal.enabled")) {
		ctx.reply.failure({
			scope: "Session",
			code: "MODE_DISABLED",
			message: "Goal mode is disabled. Enable it in settings (goal.enabled).",
			retryable: false,
		});
		return;
	}

	const { sub, rest } = parseGoalSubcommand(args);
	const driver = await attachGoalBridge(session, ctx.clientState, ctx.socket);

	if (sub === "show") {
		ctx.reply.snapshot(goalSection(session, driver, ctx.clientState.goalBridge?.stoodDown));
		ctx.reply.success();
		return;
	}

	if (sub === "pause") {
		const state = session.getGoalModeState();
		if (!state?.goal) {
			ctx.reply.failure({
				scope: "Session",
				code: "NO_GOAL",
				message: "The session has no goal to pause. Set a goal first with /goal <objective>.",
				retryable: false,
			});
			return;
		}
		if (!driver.enabled && state.goal.status === "paused") {
			ctx.reply.success();
			return;
		}
		await driver.pause();
		ctx.reply.success();
		return;
	}

	if (sub === "resume") {
		const state = session.getGoalModeState();
		if (!state?.goal) {
			ctx.reply.failure({
				scope: "Session",
				code: "NO_GOAL",
				message: "The session has no goal to resume. Set a goal first with /goal <objective>.",
				retryable: false,
			});
			return;
		}
		if (state.goal.status === "dropped") {
			ctx.reply.failure({
				scope: "Session",
				code: "GOAL_DROPPED",
				message: "Cannot resume a dropped goal. Set a new goal instead with /goal <objective>.",
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

	if (sub === "drop") {
		const state = session.getGoalModeState();
		if (!state?.goal) {
			ctx.reply.failure({
				scope: "Session",
				code: "NO_GOAL",
				message: "The session has no goal to drop.",
				retryable: false,
			});
			return;
		}
		await driver.drop();
		ctx.reply.success();
		return;
	}

	const objective = (sub === "set" ? rest : rest || args).trim();
	if (!objective) {
		const state = session.getGoalModeState();
		if (state?.goal) {
			ctx.reply.snapshot(goalSection(session, driver, ctx.clientState.goalBridge?.stoodDown));
			ctx.reply.success();
			return;
		}
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "Usage: /goal <objective> | /goal pause | /goal resume | /goal drop | /goal show",
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

	if (driver.enabled) {
		await driver.replaceGoal({ objective });
	} else {
		await driver.enter({ objective });
	}
	driver.scheduleContinuation();
	ctx.reply.success();
};

const HANDLERS: Record<DesktopHostCommandName, HostCommand> = { btw, goal };

/** Runs `name` against `session`, replying to the request it arrived on. */
export async function runDesktopHostCommand(
	ctx: ActionContext,
	session: AgentSession,
	name: DesktopHostCommandName,
	args: string,
): Promise<void> {
	await HANDLERS[name](ctx, session, args);
}
