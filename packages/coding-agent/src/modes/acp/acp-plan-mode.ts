import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AgentToolResult } from "@veyyon/pi-agent-core";
import { isEnoent, logger } from "@veyyon/pi-utils";
import { resolveLocalUrlToPath } from "../../internal-urls";
import { type PlanApprovalDetails, resolveApprovedPlan } from "../../plan-mode/approved-plan";
import type { AgentSession } from "../../session/agent-session";
import { normalizeLocalScheme } from "../../tools/path-utils";
import { runResolveInvocation } from "../../tools/resolve";
import { ToolError } from "../../tools/tool-errors";
import { elicitFromAcpClient } from "./acp-elicitation";
import {
	ACP_PLAN_MODE_ID,
	buildCurrentModeUpdate,
	getAvailableModes,
	pushConfigOptionUpdate,
} from "./acp-session-config";

const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
const APPROVE_OPTION = "Approve and execute";
const REFINE_OPTION = "Refine plan";

/** The connection-side dependencies plan mode needs from the ACP agent. */
export interface AcpPlanModeContext {
	connection: AgentSideConnection;
	clientCapabilities: ClientCapabilities | undefined;
}

/** Switch `session` between the ACP default and plan modes, wiring/unwiring the standing plan-approval resolve handler. */
export function applyModeChange(ctx: AcpPlanModeContext, session: AgentSession, modeId: string): void {
	const availableModes = getAvailableModes(session);
	if (!availableModes.some(mode => mode.id === modeId)) {
		throw new Error(`Unsupported ACP mode: ${modeId}`);
	}
	if (modeId === ACP_PLAN_MODE_ID) {
		const previous = session.getPlanModeState();
		session.setPlanModeState({
			enabled: true,
			planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
			workflow: previous?.workflow ?? "parallel",
			reentry: previous !== undefined,
		});
		// Mirror `InteractiveMode.#enterPlanMode`: register the standing resolve
		// handler that consumes `resolve { action: "apply" }` from plan-mode.
		// Without this, the agent's resolve call falls through to the "No
		// pending action to resolve" error (issue #1869).
		session.setStandingResolveHandler?.(input => runAcpPlanApprovalResolve(ctx, session, input));
	} else {
		session.setStandingResolveHandler?.(null);
		session.setPlanModeState(undefined);
	}
}

/**
 * Standing resolve handler installed while ACP plan mode is active. The agent
 * submits the finalized plan via `resolve { action: "apply", extra: { title } }`;
 * this handler validates the plan file, normalizes the title, asks the ACP
 * client to confirm (via `unstable_createElicitation` when supported), and on
 * approval renames the plan to `local://<title>.md`, exits plan mode, and
 * notifies the client of both mode surfaces so the agent regains full tools.
 *
 * Mirrors `InteractiveMode.#runPlanApprovalResolve` for the parts the agent
 * sees (same `PlanApprovalDetails` shape, same source tool name `plan_approval`).
 * Clients without form-mode elicitation get an auto-approve so plan mode is
 * never stranded — the agent always has a way out.
 */
export function runAcpPlanApprovalResolve(
	ctx: AcpPlanModeContext,
	session: AgentSession,
	input: unknown,
): Promise<AgentToolResult<unknown>> {
	return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
		sourceToolName: "plan_approval",
		label: "Plan ready for approval",
		apply: async (_reason, extra) => {
			const state = session.getPlanModeState();
			if (!state?.enabled) {
				throw new ToolError("Plan mode is not active.");
			}
			const { planFilePath, planContent, title } = await resolveApprovedPlan({
				suppliedTitle: extra?.title,
				statePlanFilePath: state.planFilePath,
				readPlan: url => readAcpPlanFile(session, url),
				listPlanFiles: () => listAcpLocalPlanFiles(session),
			});
			const approved = await requestAcpPlanApprovalChoice(ctx, session.sessionId, title, planContent);
			const details: PlanApprovalDetails = {
				planFilePath,
				title,
				planExists: true,
			};
			if (!approved) {
				// User chose to refine: leave plan mode active so the agent
				// keeps the read-only toolset and can iterate on the plan file.
				return {
					content: [
						{
							type: "text" as const,
							text: 'Plan refinement requested. Update the plan file, then call `resolve { action: "apply" }` again when ready.',
						},
					],
					details,
				};
			}
			// Approved. Set the plan reference so the next turn injects the plan
			// content as context (the file keeps its agent-chosen name — no
			// rename), then exit plan mode so the agent regains full tools.
			session.setPlanReferencePath(planFilePath);
			session.setStandingResolveHandler?.(null);
			session.setPlanModeState(undefined);
			try {
				await ctx.connection.sessionUpdate({
					sessionId: session.sessionId,
					update: buildCurrentModeUpdate(session),
				});
				await pushConfigOptionUpdate(ctx.connection, session);
			} catch (error) {
				logger.warn("Failed to emit mode updates after plan approval", {
					sessionId: session.sessionId,
					error,
				});
			}
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

function resolveAcpPlanFilePath(session: AgentSession, planFilePath: string): string {
	if (planFilePath.startsWith("local:")) {
		const normalized = normalizeLocalScheme(planFilePath);
		return resolveLocalUrlToPath(normalized, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
	}
	return path.resolve(session.sessionManager.getCwd(), planFilePath);
}

async function readAcpPlanFile(session: AgentSession, planFilePath: string): Promise<string | null> {
	const resolvedPath = resolveAcpPlanFilePath(session, planFilePath);
	try {
		return await Bun.file(resolvedPath).text();
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
}

/** `local://` URLs of plan files in the session-local root, newest first —
 *  the `resolveApprovedPlan` fallback for a dropped `extra.title`. */
async function listAcpLocalPlanFiles(session: AgentSession): Promise<string[]> {
	const localRoot = resolveAcpPlanFilePath(session, "local://");
	try {
		const entries = await fs.readdir(localRoot, { withFileTypes: true });
		const plans = await Promise.all(
			entries
				.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
				.map(async entry => {
					const stat = await fs.stat(path.join(localRoot, entry.name)).catch(() => null);
					return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
				}),
		);
		return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
	} catch {
		return [];
	}
}

/**
 * Ask the ACP client to confirm plan approval. Returns `true` only on an
 * explicit `APPROVE_OPTION` selection. Refine, dismissal (`undefined`), or
 * any unrecognized value falls through to refine semantics — the caller
 * keeps plan mode active and surfaces guidance text to the agent. Clients
 * without `elicitation.form` support auto-approve because there is no
 * confirmation surface available; without that, plan mode would strand
 * the agent (the bug this function exists to fix).
 */
async function requestAcpPlanApprovalChoice(
	ctx: AcpPlanModeContext,
	sessionId: string,
	title: string,
	planContent: string,
): Promise<boolean> {
	const supportsForm = ctx.clientCapabilities?.elicitation?.form != null;
	if (!supportsForm) return true;
	// Include a short preview of the plan so the user has context in the
	// dialog. Keep the body bounded — Zed renders elicitation messages
	// inline and a multi-thousand-line plan blows out the dialog.
	const previewLines = planContent.split("\n").slice(0, 12).join("\n");
	const ellipsis = planContent.split("\n").length > 12 ? "\n…" : "";
	const message = `Approve plan "${title}" and start implementation?\n\n${previewLines}${ellipsis}`;
	const value = await elicitFromAcpClient(
		ctx.connection,
		sessionId,
		"select",
		message,
		{ type: "string", enum: [APPROVE_OPTION, REFINE_OPTION] },
		undefined,
	);
	// Approve ONLY on the explicit approve selection. Dismissal, cancel,
	// timeout, or any other non-approve response falls through to refine
	// semantics so closing the dialog can never grant write access.
	return value === APPROVE_OPTION;
}
