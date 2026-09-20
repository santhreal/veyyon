/**
 * `ReviewPlan`: the plan the agent wrote, raised for review on the operator's ask.
 *
 * A plan decision is ordinarily raised from inside the agent's `resolve` call,
 * which is the one moment the agent chooses. This raises the same decision
 * without one, off the newest `local://<slug>-plan.md` the session wrote,
 * which is how a plan is reviewed again after its card was dismissed and how
 * a plan the agent drafted without calling `resolve` is reviewed at all. It
 * is the desktop's `/plan-review`.
 *
 * With no tool call in flight there is no tool result to answer, so each
 * outcome reaches the agent as a turn carrying the text `resolve` would have
 * returned: an approval leaves plan mode and says so, a refusal leaves plan
 * mode on and asks for a revision. The session therefore lands in the same
 * state under either route.
 */
import { errorMessage, logger } from "@veyyon/utils";
import { listLocalPlanFileUrls } from "../../internal-urls/local-protocol";
import { resolveApprovedPlan } from "../../plan-mode/approved-plan";
import type { AgentSession } from "../../session/agent-session";
import type { InteractionLedger } from "../interactions";
import { exitPlanMode, readSessionPlan, sessionPlanPath } from "../plan-approval";
import { executePromptTurn, getOrCreateAgentSession } from "../turns";
import { activateSession } from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

interface ReviewPlanPayload {
	session?: string;
}

/**
 * Locate the plan, newest first.
 *
 * `getPlanReferencePath()` is empty until a plan is approved and does not
 * survive a restart, and plan-mode state carries the default URL until the
 * agent names one, so neither identifies the plan on its own. The artifact
 * files do persist, so the newest one is the plan under discussion, with the
 * state path as the fallback the resolver already knows how to report on.
 */
async function locatePlan(
	session: AgentSession,
	statePlanFilePath: string,
): Promise<{ planFilePath: string; planContent: string }> {
	const root = sessionPlanPath(session, "local://");
	const [newest] = await listLocalPlanFileUrls(root);
	return await resolveApprovedPlan({
		statePlanFilePath: newest ?? statePlanFilePath,
		readPlan: url => readSessionPlan(session, url),
		listPlanFiles: () => listLocalPlanFileUrls(root),
	});
}

/**
 * Carry what the operator decided back to the agent.
 *
 * Neither branch reports on the request that raised the card: that request
 * settled when the card went up, and what follows is a turn, which reaches
 * the window as a turn.
 */
async function carryOutcome(
	ctx: ActionContext,
	session: AgentSession,
	ledger: InteractionLedger,
	planFilePath: string,
	planContent: string,
): Promise<void> {
	const { accepted, feedback } = await ledger.plan(planContent);
	if (!accepted) {
		const refinement = feedback.trim();
		if (!refinement) return;
		await executePromptTurn(
			session,
			ctx.clientState,
			`Plan refinement requested: ${refinement}\nUpdate the plan file accordingly, then call \`resolve { action: "apply" }\` again when ready.`,
		);
		return;
	}
	session.setPlanReferencePath(planFilePath);
	await exitPlanMode(session, ctx.clientState);
	await executePromptTurn(
		session,
		ctx.clientState,
		`Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
	);
}

/**
 * Raise the plan for review.
 *
 * The request settles when the card is up rather than when it is answered: a
 * decision waiting on a person is not a request in flight, and the window
 * answers it through `RespondToInteraction` like every other card.
 */
const handleReviewPlan: ActionHandler<ReviewPlanPayload | undefined> = async (ctx, payload) => {
	if (payload?.session && !(await activateSession(ctx, payload.session))) return;
	const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
	if (!session.getPlanModeState()?.enabled) {
		ctx.reply.failure({
			scope: "Session",
			code: "NOT_IN_PLAN_MODE",
			message: "Plan mode is not active; there is no plan to review",
			retryable: false,
		});
		return;
	}
	if (session.isStreaming) {
		// A card raised beside a running turn competes with the one the
		// agent's own `resolve` is about to raise, and the two would answer
		// the same plan to two different places.
		ctx.reply.failure({
			scope: "Session",
			code: "TURN_IN_PROGRESS",
			message: "A turn is running; the plan can be reviewed once it ends",
			retryable: true,
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
	let located: { planFilePath: string; planContent: string };
	try {
		located = await locatePlan(session, session.getPlanModeState()?.planFilePath ?? "");
	} catch (error) {
		ctx.reply.failure({
			scope: "Session",
			code: "NO_PLAN",
			message: `No plan to review yet: ${errorMessage(error)}`,
			retryable: false,
		});
		return;
	}
	ctx.reply.success();
	void carryOutcome(ctx, session, ledger, located.planFilePath, located.planContent).catch((error: unknown) => {
		logger.error("gui-host: plan review outcome failed", { error: errorMessage(error) });
	});
};

export const planReviewActionHandlers: ActionHandlersMap = {
	ReviewPlan: handleReviewPlan as ActionHandler<never>,
};
