import type { Effort } from "@veyyon/catalog/effort";

export type ThinkingBudgetSchedule = Readonly<Record<Effort, number>>;

export const ANTHROPIC_THINKING_BUDGETS: ThinkingBudgetSchedule = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16_384,
	xhigh: 32_768,
	max: 32_768,
};

export const BEDROCK_CLAUDE_THINKING_BUDGETS: ThinkingBudgetSchedule = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16_384,
	xhigh: 32_768,
	max: 32_768,
};

export const GOOGLE_THINKING_BUDGETS: ThinkingBudgetSchedule = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16_384,
	xhigh: 24_575,
	max: 32_768,
};

/** Resolve one transport's budget with caller and model metadata taking precedence over defaults. */
export function resolveThinkingBudget(
	effort: Effort,
	defaults: ThinkingBudgetSchedule,
	custom?: Partial<Record<Effort, number>>,
	model?: Partial<Record<Effort, number>>,
): number {
	return custom?.[effort] ?? model?.[effort] ?? defaults[effort];
}
