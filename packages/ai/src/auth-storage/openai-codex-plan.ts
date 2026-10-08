/**
 * OpenAI Codex plan tiers: the tier a model requires and the tier a usage report states.
 */

import type { UsageReport } from "../usage";

export type OpenAICodexPlanRequirement = "none" | "paid" | "pro";
type OpenAICodexPlanClass = "free" | "paid" | "pro" | "unknown";

const GPT_56_PAID_CODEX_MODEL_PATTERN = /^gpt-5\.6-(?:sol|luna)(?:-pro)?$/;
const OPENAI_CODEX_PRO_PLAN_TOKENS: Record<string, true> = {
	pro: true,
};
const OPENAI_CODEX_PAID_PLAN_TOKENS: Record<string, true> = {
	plus: true,
	business: true,
	team: true,
	enterprise: true,
	edu: true,
	education: true,
	teacher: true,
	teachers: true,
	health: true,
	gov: true,
	government: true,
};
const OPENAI_CODEX_FREE_PLAN_TOKENS: Record<string, true> = {
	free: true,
	go: true,
};

/**
 * Account tier needed for model-aware Codex OAuth routing.
 *
 * GPT-5.6 Terra (including its local pro-mode alias) remains available on every
 * plan. Sol and Luna pro-mode aliases inherit their base models' paid tier;
 * only Spark currently has a documented Pro-plan preference in Codex.
 */
export function resolveOpenAICodexPlanRequirement(
	provider: string,
	modelId: string | undefined,
): OpenAICodexPlanRequirement {
	if (provider !== "openai-codex" || typeof modelId !== "string") return "none";
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).toLowerCase();
	if (bareModelId.includes("-spark")) return "pro";
	if (bareModelId === "gpt-5.6" || GPT_56_PAID_CODEX_MODEL_PATTERN.test(bareModelId)) return "paid";
	return "none";
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata) return undefined;
	const planType = metadata.planType;
	if (typeof planType !== "string") return undefined;
	const normalized = planType
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized.startsWith("chatgpt_") ? normalized.slice("chatgpt_".length) : normalized;
}

function classifyOpenAICodexPlan(report: UsageReport | null): OpenAICodexPlanClass {
	const planType = getUsagePlanType(report);
	if (!planType) return "unknown";
	// Pro Lite is a paid Codex tier, but does not imply full Pro-only model access.
	if (planType === "prolite" || planType === "pro_lite") return "paid";
	const tokens = planType.split("_");
	if (tokens.some(token => OPENAI_CODEX_PRO_PLAN_TOKENS[token] === true)) return "pro";
	if (tokens.some(token => OPENAI_CODEX_PAID_PLAN_TOKENS[token] === true)) return "paid";
	if (tokens.some(token => OPENAI_CODEX_FREE_PLAN_TOKENS[token] === true)) return "free";
	return "unknown";
}

export function getOpenAICodexPlanEligibility(
	report: UsageReport | null,
	requirement: OpenAICodexPlanRequirement,
): boolean | undefined {
	if (requirement === "none") return true;
	const planClass = classifyOpenAICodexPlan(report);
	if (planClass === "unknown") return undefined;
	return requirement === "paid" ? planClass !== "free" : planClass === "pro";
}

export function getOpenAICodexPlanPriority(
	report: UsageReport | null,
	requirement: OpenAICodexPlanRequirement,
): number {
	const eligibility = getOpenAICodexPlanEligibility(report, requirement);
	return eligibility === true ? 0 : eligibility === undefined ? 1 : 2;
}
