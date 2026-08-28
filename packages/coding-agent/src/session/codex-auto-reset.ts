import type { OAuthAccountIdentity, ResetCreditTarget, UsageReport } from "@veyyon/ai";
import { HOUR_MS, MINUTE_MS, WEEK_MS } from "@veyyon/utils";
import type { CodexAutoRedeemMode } from "../config/settings-schema";
import { reportMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";

export const WEEKLY_EXHAUSTED_MIN_FRACTION = 0.999;
export const MAX_PLAUSIBLE_REMAINING_MS = WEEK_MS + HOUR_MS;

export const REPORT_FRESHNESS_MS = 10 * MINUTE_MS;
export const ATTEMPT_COOLDOWN_MS = 60_000;
export const DEBOUNCE_BUCKET_MS = 60_000;

export function shouldEvaluateCodexAutoRedeem(mode: CodexAutoRedeemMode): boolean {
	return mode !== "no";
}

export function shouldPromptCodexAutoRedeem(mode: CodexAutoRedeemMode): boolean {
	return mode === "unset";
}

export type CodexAutoRedeemSkipReason =
	| "disabled"
	| "wrong-provider"
	| "spark-model"
	| "no-identity"
	| "no-report"
	| "stale-report"
	| "not-limit-reached"
	| "weekly-not-exhausted"
	| "no-reset-time"
	| "reset-too-soon"
	| "reset-implausible"
	| "credits-unknown"
	| "reserve"
	| "already-attempted"
	| "cooldown";

export interface CodexAutoRedeemInput {
	nowMs: number;
	provider: string;
	modelId: string;
	settings: { autoRedeem: boolean; minBlockedMinutes: number; keepCredits: number };
	identity: OAuthAccountIdentity | undefined;
	reports: UsageReport[] | null;
	attemptedBlockKeys: ReadonlySet<string>;
	lastAttemptAtByAccount: ReadonlyMap<string, number>;
}

export interface CodexAutoRedeemRedeemDecision {
	redeem: true;
	target: ResetCreditTarget;
	accountKey: string;
	blockKey: string;
	weeklyResetAtMs: number;
	remainingMs: number;
	availableCount: number;
}

export type CodexAutoRedeemDecision =
	| CodexAutoRedeemRedeemDecision
	| { redeem: false; reason: CodexAutoRedeemSkipReason };

function normalize(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function evaluateCodexAutoRedeem(input: CodexAutoRedeemInput): CodexAutoRedeemDecision {
	const { nowMs, settings } = input;
	if (!settings.autoRedeem) return { redeem: false, reason: "disabled" };
	if (input.provider !== "openai-codex") return { redeem: false, reason: "wrong-provider" };
	if (input.modelId.includes("-spark")) return { redeem: false, reason: "spark-model" };

	const accountKey = normalize(input.identity?.accountId) ?? normalize(input.identity?.email);
	if (!accountKey) return { redeem: false, reason: "no-identity" };

	const report = input.reports?.find(
		r => r.provider === "openai-codex" && reportMatchesActiveAccount(r, input.identity),
	);
	if (!report) return { redeem: false, reason: "no-report" };
	if (nowMs - report.fetchedAt > REPORT_FRESHNESS_MS) return { redeem: false, reason: "stale-report" };
	if (report.metadata?.limitReached !== true) return { redeem: false, reason: "not-limit-reached" };

	const weekly = report.limits.find(l => l.id === "openai-codex:secondary");
	const wUsed = weekly?.amount.usedFraction;
	if (!weekly || wUsed === undefined || wUsed < WEEKLY_EXHAUSTED_MIN_FRACTION) {
		return { redeem: false, reason: "weekly-not-exhausted" };
	}

	const resetsAt = weekly.window?.resetsAt;
	if (resetsAt === undefined) return { redeem: false, reason: "no-reset-time" };
	const remainingMs = resetsAt - nowMs;
	if (remainingMs < settings.minBlockedMinutes * 60_000) return { redeem: false, reason: "reset-too-soon" };
	if (remainingMs > MAX_PLAUSIBLE_REMAINING_MS) return { redeem: false, reason: "reset-implausible" };

	const available = report.resetCredits?.availableCount;
	if (available === undefined) return { redeem: false, reason: "credits-unknown" };
	if (available - Math.max(0, Math.trunc(settings.keepCredits)) < 1) {
		return { redeem: false, reason: "reserve" };
	}

	const blockKey = `${accountKey}|${Math.round(resetsAt / DEBOUNCE_BUCKET_MS)}`;
	if (input.attemptedBlockKeys.has(blockKey)) return { redeem: false, reason: "already-attempted" };
	const lastAt = input.lastAttemptAtByAccount.get(accountKey);
	if (lastAt !== undefined && nowMs - lastAt < ATTEMPT_COOLDOWN_MS) return { redeem: false, reason: "cooldown" };

	return {
		redeem: true,
		target: { accountId: input.identity?.accountId, email: input.identity?.email },
		accountKey,
		blockKey,
		weeklyResetAtMs: resetsAt,
		remainingMs,
		availableCount: available,
	};
}

export interface CodexAutoRedeemCoordinator {
	attemptedBlockKeys: Set<string>;
	lastAttemptAtByAccount: Map<string, number>;
	inFlightByAccount: Map<string, Promise<boolean>>;
}

export const defaultCodexAutoRedeemCoordinator: CodexAutoRedeemCoordinator = {
	attemptedBlockKeys: new Set(),
	lastAttemptAtByAccount: new Map(),
	inFlightByAccount: new Map(),
};
