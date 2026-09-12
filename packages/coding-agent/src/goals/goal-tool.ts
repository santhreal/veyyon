import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { prompt } from "@veyyon/utils";
import { type } from "arktype";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/core/tool-errors";
import { goalToolView } from "./goal-view";
import { completionBudgetReport, remainingTokens } from "./runtime";
import type { Goal, GoalToolDetails } from "./state";

const goalSchema = type({
	op: type("'create' | 'get' | 'complete' | 'resume' | 'drop'").describe("goal operation"),
	"objective?": type("string").describe("goal objective"),
});

export type GoalToolInput = typeof goalSchema.infer;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean; budgetsEnabled?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: options?.budgetsEnabled ? remainingTokens(resolvedGoal) : null,
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(
						options.budgetsEnabled ? resolvedGoal : { ...resolvedGoal, tokenBudget: undefined },
					)
				: null,
	};
}

function validateCreateParams(params: GoalToolInput): { objective: string } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError("objective is required when op=create");
	}
	return { objective };
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "Goal";
	readonly description = prompt.render(toolsPrompts["tools/goal"].text);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	/**
	 * The tool rewrites the session's goal record and nothing in the workspace, the same tier as its
	 * hidden siblings (`yield`, `resolve`, `report_finding`). Without a tier `normalizeDecision`
	 * defaults to `exec`, which prompts in `ask-command` and is denied outright in plan mode.
	 */
	readonly approval = "read" as const;
	/**
	 * The tool's own card, as data. Declared here so the live tool carries it and any host that draws
	 * a transcript reads it off the tool rather than from a terminal-side registry.
	 */
	readonly view = goalToolView;
	/** The result card is the whole card: it repeats the header the call row drew. */
	readonly mergeCallAndResult = true;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		if ("token_budget" in params) {
			throw new ToolError("token_budget is not supported; model goal budgets are controlled in Settings.");
		}
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) {
			throw new ToolError("Goal mode is not active.");
		}

		const budgetsEnabled = this.#session.settings.get("goal.modelBudgetsEnabled");
		let response: GoalToolResponse;
		if (params.op === "create") {
			const created = await runtime.createGoal(validateCreateParams(params));
			response = buildGoalToolResponse(created.goal, { budgetsEnabled });
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null, { budgetsEnabled });
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal, { budgetsEnabled });
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null, { budgetsEnabled });
		} else {
			const completed = await runtime.completeGoalFromTool();
			response = buildGoalToolResponse(completed, { includeCompletionReport: true, budgetsEnabled });
		}
		let text: string;
		if (response.goal) {
			text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
			if (budgetsEnabled && response.goal.tokenBudget !== undefined) {
				text += ` / ${response.goal.tokenBudget} budget`;
			}
			if (budgetsEnabled && response.remainingTokens !== null) {
				text += `\nRemaining tokens: ${response.remainingTokens}`;
			}
			if (response.completionBudgetReport) {
				text += `\n\n${response.completionBudgetReport}`;
			}
		} else {
			text = "No active goal.";
		}
		return {
			content: [{ type: "text", text }],
			details: {
				op: params.op,
				goal: response.goal,
				remainingTokens: response.remainingTokens,
				completionBudgetReport: response.completionBudgetReport,
			},
		};
	}
}
