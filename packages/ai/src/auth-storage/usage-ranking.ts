/**
 * Candidate ordering by usage: window drain, plan eligibility, blocks, and the account the
 * caller chose.
 */

import { clamp01 } from "@veyyon/utils/math";
import type { UsageLimit, UsageReport } from "../usage";
import type { CredentialSelection } from "./credentials";
import type { OpenAICodexPlanRequirement } from "./openai-codex-plan";
import type { ApiKeyCredential, AuthCredential, OAuthCredential } from "./types";

const USAGE_RANKING_METRIC_EPSILON = 1e-9;
/**
 * Primary (short, e.g. 5h) window used-fraction at or above which a candidate
 * is demoted behind cooler siblings during ranking: a nearly exhausted short
 * window means an imminent mid-session block, so drain urgency defers to it.
 */
const PRIMARY_WINDOW_HOT_FRACTION = 0.85;

function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

export type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
};

export type OAuthCandidate = UsageCandidate<OAuthCredential>;
export type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
export type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & { blockedUntil: number | undefined };

export type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
	blocked: boolean;
	blockedUntil?: number;
	hasPriorityBoost: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryRequiredDrain: number;
	primaryUsed: number;
	primaryRequiredDrain: number;
	orderPos: number;
};

function resolveWindowResetAt(window: UsageLimit["window"]): number | undefined {
	if (!window) return undefined;
	if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
		return window.resetsAt;
	}
	return undefined;
}

export function normalizeUsageFraction(limit: UsageLimit | undefined): number {
	const usedFraction = limit?.amount.usedFraction;
	if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
		return 0.5;
	}
	return clamp01(usedFraction);
}

/**
 * Computes the required drain rate: `headroomFraction / remainingHours` —
 * how fast the window's remaining quota must be consumed to fully use it
 * before it resets and expires. Higher = more headroom at risk of expiring
 * unused = ranked first, so selection chases quota that is about to be
 * wasted ("use it or lose it"). Without a reset clock the headroom
 * fraction alone is returned, degrading to most-headroom-first.
 */
export function computeWindowRequiredDrain(
	limit: UsageLimit | undefined,
	nowMs: number,
	fallbackDurationMs: number,
): number {
	const headroom = 1 - normalizeUsageFraction(limit);
	if (headroom <= 0) return 0;
	const resetAt = resolveWindowResetAt(limit?.window);
	if (resetAt === undefined) return headroom;
	const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
	let remainingMs = resetAt - nowMs;
	if (Number.isFinite(durationMs) && durationMs > 0) {
		remainingMs = Math.min(remainingMs, durationMs);
	}
	// Floor at one minute: a stale report whose reset already passed must
	// not produce an unbounded urgency score.
	const remainingHours = Math.max(remainingMs, 60_000) / (60 * 60 * 1000);
	return headroom / remainingHours;
}

function compareUsageRankedCandidatePriority(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planRequirement: OpenAICodexPlanRequirement,
): number {
	if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
	if (left.blocked && right.blocked) {
		const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
		const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
		if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
		return 0;
	}
	if (planRequirement !== "none" && left.planPriority !== right.planPriority) {
		return left.planPriority - right.planPriority;
	}
	if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
	// Short-window guard: candidates whose primary (e.g. 5h) window is
	// nearly exhausted rank behind cool ones regardless of drain urgency —
	// overflow lands on the next-most-urgent cool account instead.
	const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	if (leftHot !== rightHot) return leftHot ? 1 : -1;
	// Usage-backed candidates outrank unmeasured ones: required-drain
	// scores are only comparable between measured windows, and the
	// clockless headroom fallback (0..1) must not let an account whose
	// usage fetch failed shadow a measured sibling.
	const leftMeasured = left.usage !== null;
	const rightMeasured = right.usage !== null;
	if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
	// Required drain, descending: the account whose remaining quota must
	// burn fastest to avoid expiring unused at its reset comes first, so
	// staggered resets land at ~100% utilization instead of stranding
	// headroom that a cooler sibling could have absorbed.
	let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
	if (metric !== 0) return metric;
	return 0;
}

function compareUsageRankedCandidates(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planRequirement: OpenAICodexPlanRequirement,
): number {
	const priority = compareUsageRankedCandidatePriority(left, right, planRequirement);
	return priority !== 0 ? priority : left.orderPos - right.orderPos;
}

export function orderUsageRankedCandidates<T extends AuthCredential>(
	candidates: UsageRankedCandidate<T>[],
	planRequirement: OpenAICodexPlanRequirement,
): UsageCandidate<T>[] {
	candidates.sort((left, right) => compareUsageRankedCandidates(left, right, planRequirement));
	return candidates.map(candidate => ({
		selection: candidate.selection,
		usage: candidate.usage,
		usageChecked: candidate.usageChecked,
	}));
}

/**
 * Put the explicitly chosen account at the head of an ordered candidate list.
 *
 * A choice outranks availability: a hold is this library's own prediction of when a provider
 * will serve again, and it is not a reason to spend money on an account nobody asked for. So the
 * move is unconditional, unlike the session-preference case in `#resolveOAuthSelection`, which
 * leads only while it is usable.
 */
export function leadWithChosenAccount<C extends { index: number }>(ordered: C[], chosenIndex: number | undefined): C[] {
	if (chosenIndex === undefined) return ordered;
	const at = ordered.findIndex(candidate => candidate.index === chosenIndex);
	if (at <= 0) return ordered;
	const [chosen] = ordered.splice(at, 1);
	if (chosen) ordered.unshift(chosen);
	return ordered;
}
