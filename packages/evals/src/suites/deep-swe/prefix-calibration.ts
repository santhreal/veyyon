/**
 * Prefix calibration and character-to-token regression against billed prompt tokens.
 *
 * Regresses what the provider charged against what the transcript shows, measuring
 * characters per token and unseen prefix mass (such as tool schemas).
 */

import { PREFIX_CATEGORIES, sessionPrefixSteps, type TranscriptRecord } from "./prefix-mass";

/** One billed turn: the prefix we can see, against the prompt tokens the provider charged for. */
export interface PrefixObservation {
	readonly visibleChars: number;
	readonly promptTokens: number;
}

/**
 * Pair every billed turn's visible prefix size with the prompt tokens the
 * provider charged for it, which is the input {@link calibratePrefix} fits.
 */
export function prefixObservations(records: TranscriptRecord[]): PrefixObservation[] {
	const usages: number[] = [];
	for (const record of records) {
		if (record.type !== "message") continue;
		const usage = record.message?.usage as Record<string, number> | undefined;
		if (record.message?.role !== "assistant" || !usage) continue;
		usages.push((usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
	}
	const observations: PrefixObservation[] = [];
	let visible = 0;
	let turn = 0;
	for (const step of sessionPrefixSteps(records)) {
		if (step.kind === "billedTurn") {
			const promptTokens = usages[turn++];
			if (promptTokens) observations.push({ visibleChars: visible, promptTokens });
			continue;
		}
		for (const category of PREFIX_CATEGORIES) visible += step.delta[category] ?? 0;
	}
	return observations;
}

/**
 * Fit `promptTokens = visibleChars / charsPerToken + unseen` across billed turns.
 *
 * Returns null for fewer than two observations or for a degenerate fit (every
 * turn showing the same visible size).
 */
export function calibratePrefix(
	observations: readonly PrefixObservation[],
): { charsPerToken: number; unseenChars: number } | null {
	const n = observations.length;
	if (n < 2) return null;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (const { visibleChars, promptTokens } of observations) {
		sx += visibleChars;
		sy += promptTokens;
		sxx += visibleChars * visibleChars;
		sxy += visibleChars * promptTokens;
	}
	const denominator = n * sxx - sx * sx;
	if (denominator === 0) return null;
	const slope = (n * sxy - sx * sy) / denominator;
	if (slope <= 0) return null;
	const intercept = (sy - slope * sx) / n;
	return { charsPerToken: 1 / slope, unseenChars: intercept / slope };
}
