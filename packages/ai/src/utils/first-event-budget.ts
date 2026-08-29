import { isTimeoutError } from "@veyyon/utils/abortable";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";

const PRE_RESPONSE_STALL_PATTERN = /\btimed?\s*out\b|\btimeout\b|\bstream stall\b/i;

const ANTHROPIC_CONNECT_TIMEOUT_NAME = "AnthropicConnectionTimeoutError";

export function isPreResponseStallMessage(message: string): boolean {
	return PRE_RESPONSE_STALL_PATTERN.test(message);
}

export function isPreResponseStall(error: unknown): boolean {
	if (isTimeoutError(error)) return true;
	if (error instanceof Error) {
		if (error.name === ANTHROPIC_CONNECT_TIMEOUT_NAME) return true;
		return isPreResponseStallMessage(error.message);
	}
	return false;
}

export interface BudgetFence {
	signal: AbortSignal | undefined;
	cancel(): void;
}

export interface FirstEventBudget {
	readonly totalMs: number | undefined;
	remainingMs(): number | undefined;
	spent(): boolean;
	fence(callerSignal?: AbortSignal): BudgetFence;
}

function openFirstEventBudget(totalMs: number | undefined, now: () => number = Date.now): FirstEventBudget {
	const total = totalMs !== undefined && totalMs > 0 ? totalMs : undefined;
	const startedAt = now();
	const remainingMs = (): number | undefined => {
		if (total === undefined) return undefined;
		return Math.max(0, total - (now() - startedAt));
	};
	return {
		totalMs: total,
		remainingMs,
		spent: () => remainingMs() === 0,
		fence: callerSignal => {
			const remaining = remainingMs();
			if (remaining === undefined) return { signal: callerSignal, cancel: () => {} };
			return scopedTimeoutSignal(Math.max(1, remaining), callerSignal);
		},
	};
}

export const PRE_RESPONSE_STALL_ATTEMPTS = 2;

export function openStallLadderBudget(
	perAttemptMs: number | undefined,
	now: () => number = Date.now,
): FirstEventBudget {
	const perAttempt = perAttemptMs !== undefined && perAttemptMs > 0 ? perAttemptMs : undefined;
	return openFirstEventBudget(perAttempt === undefined ? undefined : perAttempt * PRE_RESPONSE_STALL_ATTEMPTS, now);
}

export function openBoundedFirstEventBudget(
	declaredMs: number | undefined,
	ceilingMs: number,
	now: () => number = Date.now,
): FirstEventBudget {
	const declared = declaredMs !== undefined && declaredMs > 0 ? declaredMs : undefined;
	return openFirstEventBudget(declared === undefined ? ceilingMs : Math.min(declared, ceilingMs), now);
}
