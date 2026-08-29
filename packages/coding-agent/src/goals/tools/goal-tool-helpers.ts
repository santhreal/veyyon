import { type } from "arktype";
import { ToolError } from "../../tools/tool-errors";
import { completionBudgetReport, remainingTokens } from "../runtime";
import type { Goal } from "../state";

export const goalSchema = type({
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

export function validateCreateParams(params: GoalToolInput): { objective: string } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError("objective is required when op=create");
	}
	return { objective };
}
