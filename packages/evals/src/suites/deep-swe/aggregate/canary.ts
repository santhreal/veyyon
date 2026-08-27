/**
 * Canary predicates and abort detection for early trial failures.
 */
import { isHardError } from "./error-classification";

export function shouldTripCanary(
	results: ReadonlyArray<{ error: string | null; outputTokens: number | null }>,
	canarySize: number,
): boolean {
	return results.length >= canarySize && results.length > 0 && results.every(isHardError);
}

export function armCanaryFailure(
	results: ReadonlyArray<{ arm: string; error: string | null; outputTokens: number | null }>,
	canarySize: number,
): string | undefined {
	if (canarySize <= 0) return undefined;
	const completed = new Map<string, { total: number; hard: number }>();
	for (const result of results) {
		const entry = completed.get(result.arm) ?? { total: 0, hard: 0 };
		entry.total += 1;
		if (isHardError(result)) entry.hard += 1;
		completed.set(result.arm, entry);
	}
	for (const [arm, { total, hard }] of completed) {
		if (total >= canarySize && hard === total) {
			return arm;
		}
	}
	return undefined;
}

export function mostCommonAgentReason(reasons: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const raw of reasons) {
		const reason = raw.trim();
		if (reason === "") continue;
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [reason, count] of counts) {
		if (count > bestCount) {
			best = reason;
			bestCount = count;
		}
	}
	return best ?? "(no agent-side reason captured; check the agent log in a failed job's trial directory)";
}
