/**
 * `SetSessionMode`: the modes a desktop operator enters and leaves.
 *
 * Plan and vibe are the two a gesture sets. Goal mode is not here: it drives
 * turns of its own from a controller the terminal owns, so a desktop request
 * for it would enter a mode nothing would then run.
 */
import { enterVibeMode, exitVibeMode } from "../../session/vibe-mode";
import { enterPlanMode, exitPlanMode } from "../plan-approval";
import { getOrCreateAgentSession } from "../turns";
import { activeManager, emitActiveSession, replyError } from "./active-session";
import type { ActionHandler } from "./types";

/** The wire spellings, matching `SettableMode` in `veyyon-desktop-model`. */
export const SESSION_MODES = ["plan", "vibe", "none"] as const;

interface SetSessionModePayload {
	session?: string;
	mode?: string;
}

/**
 * Enter or leave a session mode.
 *
 * Entering respects `plan.enabled` the way the terminal's `/plan` does, the
 * two modes refuse each other rather than stacking two tool sets, and leaving
 * a mode the session is not in is reported as such instead of appending a
 * mode change nothing asked for.
 */
export const handleSetSessionMode: ActionHandler<SetSessionModePayload | undefined> = async (ctx, payload) => {
	const mode = payload?.mode;
	if (!mode || !(SESSION_MODES as readonly string[]).includes(mode)) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: `SetSessionMode mode must be one of ${SESSION_MODES.join(", ")}`,
			retryable: false,
		});
		return;
	}
	const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
	if (session.isStreaming) {
		// Entering or leaving a mode swaps the session's tool set and the
		// standing handler the plan is resolved through. Applied under a running
		// turn that would change what the agent may call in the middle of the
		// request it is already answering, so the mode waits for the turn.
		ctx.reply.failure({
			scope: "Session",
			code: "TURN_IN_PROGRESS",
			message: "A turn is running; the mode can be changed once it ends",
			retryable: true,
		});
		return;
	}
	const inPlan = session.getPlanModeState()?.enabled === true;
	const inVibe = session.getVibeModeState()?.enabled === true;
	try {
		if (mode === "plan") {
			if (inPlan) {
				ctx.reply.success();
				return;
			}
			if (!session.settings.get("plan.enabled")) {
				ctx.reply.failure({
					scope: "Session",
					code: "MODE_DISABLED",
					message: "Plan mode is disabled. Enable it in settings (plan.enabled).",
					retryable: false,
				});
				return;
			}
			if (inVibe) {
				ctx.reply.failure({
					scope: "Session",
					code: "MODE_CONFLICT",
					message: "The session is in vibe mode; leave it before planning",
					retryable: false,
				});
				return;
			}
			const ledger = ctx.clientState.interactions;
			if (!ledger) {
				ctx.reply.failure({
					scope: "Session",
					code: "NOT_READY",
					message: "The session has no interaction surface to raise a plan on",
					retryable: true,
				});
				return;
			}
			await enterPlanMode(session, ledger, ctx.clientState);
		} else if (mode === "vibe") {
			if (inPlan) {
				ctx.reply.failure({
					scope: "Session",
					code: "MODE_CONFLICT",
					message: "The session is in plan mode; leave it before directing workers",
					retryable: false,
				});
				return;
			}
			// Entering the mode the session is already in is the mode it
			// already is: `enterVibeMode` returns without a second entry.
			await enterVibeMode(session);
		} else if (!(await exitPlanMode(session, ctx.clientState)) && !(await exitVibeMode(session)).left) {
			ctx.reply.failure({
				scope: "Session",
				code: "NOT_IN_MODE",
				message: "The session is not in a mode to leave",
				retryable: false,
			});
			return;
		}
	} catch (error) {
		replyError(ctx, "MODE_FAILED", error);
		return;
	}
	const sm = activeManager(ctx);
	if (sm) emitActiveSession(ctx, sm);
	ctx.reply.success();
};
