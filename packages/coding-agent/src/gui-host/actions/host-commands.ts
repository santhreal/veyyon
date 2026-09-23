/**
 * The commands the host answers itself, run for the window that asked.
 *
 * A command reaches here only when `desktop-commands.ts` lists it, so the
 * catalogue a window draws and the set this dispatch answers are the same
 * declarations. A handler either answers the request or fails it; throwing is
 * how it reports a failure the caller should state as one.
 */
import { errorMessage } from "@veyyon/utils";
import { debugTool, HOST_DEBUG_TOOLS, runDebugTool } from "../../debug/host-tools";
import { parseGoalSubcommand } from "../../goals/subcommands";
import { mcpManagerInstance } from "../../mcp/manager-instance";
import type { AgentSession } from "../../session/agent-session";
import { dispatchTan } from "../../task/tan";
import { shareSection } from "../collab-bridge";
import { attachCollabGuestBridge, joinRefusal, leaveShareOnWindow } from "../collab-guest-bridge";
import { appendCommandOutput } from "../command-output";
import type { DesktopHostCommandName } from "../desktop-commands";
import { attachGoalBridge } from "../goal-bridge";
import { goalSection } from "../goal-view";
import { interviewGuidedGoal } from "../guided-goal";
import { forgeRuleForWindow } from "../rule-forge";
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
 * `/tan`: tangential work dispatched to a background agent.
 *
 * The dispatch is what is awaited, not the work: the request completes when
 * the fork is registered and the transcript states it, and the agent itself
 * runs on in the roster the Agents surface draws.
 */
const tan: HostCommand = async (ctx, session, args) => {
	const dispatch = await dispatchTan(
		{
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			mcpManager: mcpManagerInstance(),
		},
		args,
	);
	if (!dispatch.ok) {
		const usage = dispatch.reason === "usage";
		ctx.reply.failure({
			scope: usage ? "Session" : "Task",
			code: usage ? "INVALID_ARGUMENTS" : "DISPATCH_FAILED",
			message: dispatch.message,
			retryable: false,
		});
		return;
	}
	ctx.reply.success();
};

/**
 * `/debug`: the debug tools a host outside the terminal can answer.
 *
 * With no argument the window is asked which tool to run, so the command
 * reaches the same list the terminal's selector draws; with one it runs that
 * tool outright, which is how a keybinding or a script reaches one. What the
 * tool states is drawn as the command's output, under the command that ran
 * it, and the three terminal-only tools are refused by name rather than
 * silently listed.
 */
const debug: HostCommand = async (ctx, session, args) => {
	const ledger = ctx.clientState.interactions;
	let id = args.trim();
	if (!id) {
		if (!ledger) {
			ctx.reply.failure({
				scope: "Session",
				code: "INVALID_ARGUMENTS",
				message: `Usage: /debug <${HOST_DEBUG_TOOLS.map(tool => tool.id).join(" | ")}>`,
				retryable: false,
			});
			return;
		}
		const chosen = await ledger.choice(
			"Debug tools",
			HOST_DEBUG_TOOLS.map(tool => ({ label: tool.label, description: tool.description })),
		);
		if (chosen === undefined) {
			ctx.reply.success();
			return;
		}
		id = HOST_DEBUG_TOOLS.find(tool => tool.label === chosen)?.id ?? "";
	}
	const tool = debugTool(id);
	if (tool?.hosts !== "any") {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: tool
				? `The ${tool.label.toLowerCase()} tool reads the terminal itself, so a window cannot run it.`
				: `No debug tool is spelled "${id}". Tools: ${HOST_DEBUG_TOOLS.map(entry => entry.id).join(", ")}`,
			retryable: false,
		});
		return;
	}
	try {
		const stated = await runDebugTool(id, {
			session,
			sessionManager: session.sessionManager,
			confirm: async (title, message, affirmative) =>
				(await ledger?.choice(`${title}\n\n${message}`, [affirmative, "Cancel"])) === affirmative,
		});
		appendCommandOutput(ctx, `debug ${id}`, stated);
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Session",
			code: "DEBUG_TOOL_FAILED",
			message: `The ${tool.label.toLowerCase()} tool failed: ${errorMessage(error)}`,
			retryable: false,
		});
	}
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

/**
 * `/guided-goal`: an objective interviewed into shape before goal mode is
 * entered on it.
 *
 * The interview is answered in the window, so it needs the ledger that raises
 * a decision there; a client that carries none is told so rather than left
 * waiting on a card nothing draws. The preconditions are goal mode's own and
 * are checked before the first question, because an interview that ends in a
 * goal that cannot be entered wastes every answer given to it.
 */
const guidedGoal: HostCommand = async (ctx, session, args) => {
	const refuse = (code: string, message: string): void => {
		ctx.reply.failure({ scope: "Session", code, message, retryable: false });
	};
	if (!session.settings.get("goal.enabled")) {
		refuse("MODE_DISABLED", "Goal mode is disabled. Enable it in settings (goal.enabled).");
		return;
	}
	if (session.getPlanModeState()?.enabled) {
		refuse("MODE_CONFLICT", "Exit plan mode first.");
		return;
	}
	if (session.getVibeModeState()?.enabled) {
		refuse("MODE_CONFLICT", "Exit vibe mode first.");
		return;
	}
	const objective = args.trim();
	const ledger = ctx.clientState.interactions;
	if (!ledger) {
		refuse("INVALID_ARGUMENTS", "This client answers no questions, so a goal cannot be interviewed here.");
		return;
	}
	const driver = await attachGoalBridge(session, ctx.clientState, ctx.socket);
	if (driver.enabled) {
		refuse("MODE_CONFLICT", "Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
		return;
	}
	const opening = objective || (await ledger.text("What is the goal?"))?.trim();
	if (!opening) {
		ctx.reply.success();
		return;
	}
	const outcome = await interviewGuidedGoal(ledger, session, opening);
	if (outcome.kind === "unresolved") {
		refuse(
			"GOAL_UNRESOLVED",
			"Guided goal setup needs more detail. Run /guided-goal again with a narrower objective.",
		);
		return;
	}
	if (outcome.kind === "objective") {
		await driver.enter({ objective: outcome.objective });
		driver.scheduleContinuation();
	}
	ctx.reply.success();
};

/**
 * `/omfg`: a rule forged from a complaint and reviewed in the window.
 *
 * The forge runs to a card rather than to a panel, so the request stays open
 * until the rule is saved or left, which is what a window draws a spinner
 * against.
 */
const omfg: HostCommand = async (ctx, session, args) => {
	await forgeRuleForWindow(ctx, session, args);
};

/**
 * `/join <link>`: the window joins the share the link names.
 *
 * The share card sends `JoinShare` for the same work. Both land on the same
 * bridge, so a room joined from the composer is the room the card states, and
 * a link typed with no room behind it fails the request rather than reaching
 * the model as a prompt.
 */
const join: HostCommand = async (ctx, session, args) => {
	const link = args.trim();
	if (!link) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "Usage: /join <link>",
			retryable: false,
		});
		return;
	}
	const refusal = joinRefusal(ctx.clientState);
	if (refusal) {
		ctx.reply.failure({
			scope: "Session",
			code: "ALREADY_HOSTING",
			message: refusal,
			retryable: false,
		});
		return;
	}
	const bridge = attachCollabGuestBridge(session, ctx.clientState, ctx.socket);
	await bridge.join(link);
	ctx.reply.snapshot(bridge.currentSection());
	ctx.reply.success();
};

/**
 * `/leave`: out of the share this window is in, either side of it.
 *
 * The terminal's `/leave` ends a hosted share too, so this does: a window
 * that typed it means the share it is in, whichever side it joined from.
 */
const leave: HostCommand = async (ctx, session) => {
	await leaveShareOnWindow(ctx.clientState);
	ctx.reply.snapshot(shareSection(ctx.clientState, session.settings));
	ctx.reply.success();
};

const HANDLERS: Record<DesktopHostCommandName, HostCommand> = {
	btw,
	debug,
	goal,
	"guided-goal": guidedGoal,
	join,
	leave,
	omfg,
	tan,
};

/** Runs `name` against `session`, replying to the request it arrived on. */
export async function runDesktopHostCommand(
	ctx: ActionContext,
	session: AgentSession,
	name: DesktopHostCommandName,
	args: string,
): Promise<void> {
	await HANDLERS[name](ctx, session, args);
}
