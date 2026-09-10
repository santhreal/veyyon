/**
 * Plan mode on a desktop-attached session.
 *
 * Entered by the same rule the terminal applies at launch: a fresh session
 * with `plan.enabled` and `plan.defaultOnStartup` set starts in plan mode. The
 * agent then drafts a plan file and calls `resolve { action: "apply" }`; the
 * standing handler installed here reads that file, raises a plan decision on
 * the session's `InteractionLedger`, and on `{ accepted: true }` exits plan
 * mode so the agent regains its full tool set. A refusal leaves plan mode on,
 * with the agent told to revise and resubmit.
 *
 * The parts the agent sees — the `plan_approval` source tool name, the
 * `PlanApprovalDetails` shape, the text of both outcomes — are the ACP
 * surface's, so a model behaves the same under either client.
 */

import * as fs from "node:fs/promises";
import { isEnoent } from "@veyyon/utils/fs-error";
import type { AgentToolResult } from "../extensibility/extensions/types";
import { listLocalPlanFileUrls } from "../internal-urls/local-protocol";
import { type PlanApprovalDetails, resolveApprovedPlan } from "../plan-mode/approved-plan";
import { DEFAULT_PLAN_FILE_URL } from "../plan-mode/plan-file-url";
import { resolvePlanFilePath } from "../plan-mode/plan-path";
import type { AgentSession } from "../session/agent-session";
import { runResolveInvocation } from "../tools/agent/resolve";
import { ToolError } from "../tools/core/tool-errors";
import type { InteractionLedger } from "./interactions";

const PLAN_TOOL = "resolve";

/**
 * Where the tool set plan mode replaced is held while plan mode is on.
 *
 * Plan mode restores the tools it took away when it ends, and it ends two
 * ways: the agent's plan is accepted, or the operator leaves. The accepting
 * path could close over the list, the operator's path cannot, so both read it
 * from the connection's state and one function performs the exit.
 */
export interface PlanModeMemory {
	planModePreviousTools?: string[];
}

/**
 * Start plan mode when the session is fresh and settings ask for it.
 * Returns whether plan mode is on afterwards.
 */
export async function enterPlanModeIfConfigured(
	session: AgentSession,
	ledger: InteractionLedger,
	memory: PlanModeMemory,
): Promise<boolean> {
	if (session.getPlanModeState()?.enabled) return true;
	const sm = session.sessionManager;
	const fresh =
		sm.buildSessionContext().messages.length === 0 && !sm.getEntries().some(entry => entry.type === "mode_change");
	if (!fresh || !session.settings.get("plan.enabled") || !session.settings.get("plan.defaultOnStartup")) {
		return false;
	}
	await enterPlanMode(session, ledger, memory);
	return true;
}

/** Restrict tools to the plan set, mark plan-mode state, and install the approval handler. */
export async function enterPlanMode(
	session: AgentSession,
	ledger: InteractionLedger,
	memory: PlanModeMemory,
): Promise<void> {
	const previousTools = session.getActiveToolNames();
	const augmentations = [PLAN_TOOL];
	if (session.hasBuiltInTool("write")) augmentations.push("write");
	await session.setActiveToolsByName([...new Set([...previousTools, ...augmentations])]);
	const previous = session.getPlanModeState();
	session.setPlanModeState({
		enabled: true,
		planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
		workflow: previous?.workflow ?? "parallel",
		reentry: previous !== undefined,
	});
	memory.planModePreviousTools = previousTools;
	session.setStandingResolveHandler(input => resolvePlanApproval(session, ledger, memory, input));
	session.sessionManager.appendModeChange("plan", { planFilePath: session.getPlanModeState()?.planFilePath });
}

/**
 * End plan mode: give the tools back, drop the standing handler and record the
 * mode the session is in now.
 *
 * Returns whether plan mode was on, so a caller can report a request to leave
 * a mode the session is not in rather than reporting a state change that did
 * not happen.
 */
export async function exitPlanMode(session: AgentSession, memory: PlanModeMemory): Promise<boolean> {
	if (!session.getPlanModeState()?.enabled) return false;
	const previousTools = memory.planModePreviousTools;
	if (previousTools && previousTools.length > 0) {
		await session.setActiveToolsByName(previousTools);
	}
	memory.planModePreviousTools = undefined;
	session.setStandingResolveHandler(null);
	session.setPlanModeState(undefined);
	session.sessionManager.appendModeChange("none");
	return true;
}

function planPath(session: AgentSession, planFilePath: string): string {
	return resolvePlanFilePath(planFilePath, {
		localProtocol: {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		},
		cwd: session.sessionManager.getCwd(),
	});
}

async function readPlan(session: AgentSession, planFilePath: string): Promise<string | null> {
	try {
		return await fs.readFile(planPath(session, planFilePath), "utf8");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function resolvePlanApproval(
	session: AgentSession,
	ledger: InteractionLedger,
	memory: PlanModeMemory,
	input: unknown,
): Promise<AgentToolResult<unknown>> {
	return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
		sourceToolName: "plan_approval",
		label: "Plan ready for approval",
		apply: async (_reason, extra) => {
			const state = session.getPlanModeState();
			if (!state?.enabled) throw new ToolError("Plan mode is not active.");
			const { planFilePath, planContent, title } = await resolveApprovedPlan({
				suppliedTitle: extra?.title,
				statePlanFilePath: state.planFilePath,
				readPlan: url => readPlan(session, url),
				listPlanFiles: () => listLocalPlanFileUrls(planPath(session, "local://")),
			});
			const details: PlanApprovalDetails = { planFilePath, title, planExists: true };
			const { accepted, feedback } = await ledger.plan(planContent);
			if (!accepted) {
				const refinement = feedback.trim();
				const text = refinement
					? `Plan refinement requested: ${refinement}\nUpdate the plan file accordingly, then call \`resolve { action: "apply" }\` again when ready.`
					: 'Plan refinement requested. Update the plan file, then call `resolve { action: "apply" }` again when ready.';
				return {
					content: [{ type: "text" as const, text }],
					details,
				};
			}
			session.setPlanReferencePath(planFilePath);
			await exitPlanMode(session, memory);
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
					},
				],
				details,
			};
		},
	});
}
