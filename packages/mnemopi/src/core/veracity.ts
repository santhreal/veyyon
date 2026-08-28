import { truncateForLog } from "../util/log-format";

export const VERACITY_MEANINGS = Object.freeze({
	stated: "the source said it outright",
	true: "checked and held",
	likely_true: "corroborated, not confirmed",
	unknown: "nothing recorded where it came from",
	inferred: "derived from something else that was said",
	imported: "brought in from another store",
	tool: "a tool reported it, so it was true when the tool ran",
	false: "checked and failed, so it should not come back",
});

export type Veracity = keyof typeof VERACITY_MEANINGS;

export const VERACITY_VALUES: readonly Veracity[] = Object.freeze(Object.keys(VERACITY_MEANINGS) as Veracity[]);

export const VERACITY_DESCRIPTION = `How much to trust this memory when recall ranks it: ${VERACITY_VALUES.map(
	value => `${value} (${VERACITY_MEANINGS[value]})`,
).join("; ")}.`;

export const VERACITY_WEIGHTS: Readonly<Record<Veracity, number>> = Object.freeze({
	stated: 1.0,
	true: 1.0,
	likely_true: 1.0,
	unknown: 0.8,
	inferred: 0.7,
	imported: 0.6,
	tool: 0.5,
	false: 0,
});

export const VERACITY_ALLOWED: Readonly<Record<Veracity, true>> = Object.freeze(
	Object.fromEntries(VERACITY_VALUES.map(value => [value, true])) as Record<Veracity, true>,
);

export function isVeracity(value: string): value is Veracity {
	return Object.hasOwn(VERACITY_MEANINGS, value);
}

const VERACITY_WARN_VALUE_CAP = 80;

const warnedVeracities = new Set<string>();

export function resetVeracityWarnings(): void {
	warnedVeracities.clear();
}

export function clampVeracity(raw: unknown, context = "veracity"): Veracity {
	if (raw === null || raw === undefined) return "unknown";
	const norm = String(raw).trim().toLowerCase();
	if (norm === "") return "unknown";
	if (isVeracity(norm)) return norm;
	if (!warnedVeracities.has(norm)) {
		warnedVeracities.add(norm);
		const rawForLog = truncateForLog(String(raw), VERACITY_WARN_VALUE_CAP);
		console.warn(`${context} received unknown veracity ${JSON.stringify(rawForLog)}; clamping to 'unknown'`);
	}
	return "unknown";
}

export function weightForVeracity(raw: unknown, context = "recall"): number {
	return VERACITY_WEIGHTS[clampVeracity(raw, context)];
}

export function aggregateVeracity(sourceVeracities: readonly string[] | null | undefined): Veracity {
	if (sourceVeracities === null || sourceVeracities === undefined || sourceVeracities.length === 0) return "unknown";
	const valid = sourceVeracities.filter(isVeracity);
	if (valid.length === 0) return "unknown";
	const nonUnknown = valid.filter(value => value !== "unknown");
	const candidates = nonUnknown.length === 0 ? valid : nonUnknown;
	const counts = new Map<Veracity, number>();
	for (const value of candidates) counts.set(value, (counts.get(value) ?? 0) + 1);
	let max = 0;
	for (const count of counts.values()) if (count > max) max = count;
	let winner: Veracity | null = null;
	for (const [value, count] of counts) {
		if (count !== max) continue;
		if (winner === null || VERACITY_WEIGHTS[value] < VERACITY_WEIGHTS[winner]) winner = value;
	}
	return winner ?? "unknown";
}
