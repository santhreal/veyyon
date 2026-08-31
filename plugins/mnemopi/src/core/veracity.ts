/**
 * What a memory's veracity can be, and what each value is worth at recall, in ONE place.
 *
 * WHY THIS MODULE EXISTS. Veracity decides whether a memory comes back. It was declared
 * four times, and the copies did not agree:
 *
 *   - `core/veracity-consolidation.ts` had five values (`stated`, `inferred`, `tool`,
 *     `imported`, `unknown`) and, because `clampVeracity` and `isVeracity` read that list,
 *     it was also the package's WRITE boundary.
 *   - `core/beam/recall.ts` had a private eight-value weight table adding `true`,
 *     `likely_true`, and `false`, and it is the READ path that scores candidates.
 *   - `types.ts` listed the consolidation five plus `(string & {})`.
 *   - `core/beam/types.ts` listed nine, adding `contested`, plus a bare `| string` that
 *     collapsed the whole union back to `string` and so checked nothing.
 *
 * Two vocabularies inside one package, with the NARROWER one validating writes, is not a
 * naming problem. `clampVeracity("false")` returned `"unknown"`, so a memory recorded as
 * known-wrong was rewritten to unlabelled and then scored 0.8 by recall instead of 0, which
 * is most of the way to being retrieved normally. `clampVeracity("true")` demoted a
 * confirmed fact from 1.0 to 0.8. `aggregateVeracity(["true", "true"])` returned
 * `"unknown"`, because `isVeracity` filtered both inputs out. Each of those also printed a
 * warning about a value this package writes itself.
 *
 * THE VOCABULARY IS THE WEIGHT TABLE'S KEYS. `Veracity` is `keyof typeof VERACITY_WEIGHTS`
 * rather than a hand-written union checked against the table, so a value cannot exist
 * without a weight and the read path needs no default for a member nobody scored. That is
 * what lets {@link weightForVeracity} index the table outright instead of falling through a
 * `?? VERACITY_WEIGHTS.unknown ?? 0.8` chain, which is how `contested` came to be scored as
 * confidently as an unlabelled memory.
 *
 * `contested` is not in the vocabulary. It appeared only as a member of the nine-value
 * union: nothing wrote it, no table weighted it, and no document mentioned it. A value the
 * package cannot produce is not a state, and admitting it only bought a silent clamp.
 *
 * The eight values here are the ones the package actually stores, confirmed against every
 * producer in the tree. Their weights are recall's, which was the only table that covered
 * all eight; the five values consolidation also knew keep the weights they had.
 */
import { truncateForLog } from "../util/log-format";

/**
 * The vocabulary, and what each value means, in the same table.
 *
 * The prose is here rather than in a comment because a model calling `memory_remember` needs
 * it: the MCP schema described the argument as "Confidence label" and named no values, so a
 * caller guessed a word and the guess was clamped to `unknown`. It reads these.
 */
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

/**
 * What a memory's veracity can be.
 *
 * Derived from {@link VERACITY_MEANINGS} on purpose. A hand-written union beside a table is a
 * second copy of the same list, and two copies of this list disagreeing is the bug the module
 * exists to end, so the list is written once and everything else is checked against it.
 */
export type Veracity = keyof typeof VERACITY_MEANINGS;

/** Every veracity, as values, for a schema or a help surface that has to enumerate them. */
export const VERACITY_VALUES: readonly Veracity[] = Object.freeze(Object.keys(VERACITY_MEANINGS) as Veracity[]);

/** The vocabulary as one sentence, for a tool schema or `--help`. */
export const VERACITY_DESCRIPTION = `How much to trust this memory when recall ranks it: ${VERACITY_VALUES.map(
	value => `${value} (${VERACITY_MEANINGS[value]})`,
).join("; ")}.`;

/**
 * How much each veracity is worth when recall scores a candidate.
 *
 * A candidate's score is multiplied by this, so `false` at 0 keeps a known-wrong memory out
 * of results rather than ranking it low, and `unknown` at 0.8 costs an unlabelled memory a
 * little against one whose source said it outright.
 *
 * `Record<Veracity, number>` and not a bare literal: the annotation is what makes a value
 * without a weight fail to compile, which is what lets {@link weightForVeracity} index this
 * table with no default. Ordered by weight for reading. Nothing depends on the order;
 * {@link aggregateVeracity} breaks ties by reading the weights.
 */
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

/**
 * The vocabulary as a lookup, kept because it is exported from a published package.
 *
 * Derived rather than written out, which is the whole point: it used to restate the five
 * keys a second time in the same file. {@link isVeracity} reads the weights directly.
 */
export const VERACITY_ALLOWED: Readonly<Record<Veracity, true>> = Object.freeze(
	Object.fromEntries(VERACITY_VALUES.map(value => [value, true])) as Record<Veracity, true>,
);

/**
 * Whether `value` is one of the eight.
 *
 * `Object.hasOwn`, not a plain index: `"constructor"` and `"toString"` reach
 * `Object.prototype` and would come back truthy from a bare lookup. The store's copy of this
 * check indexed a plain object and survived only because it compared the result to `true`.
 */
export function isVeracity(value: string): value is Veracity {
	return Object.hasOwn(VERACITY_MEANINGS, value);
}

/** How wide an unrecognized value is allowed to be in a warning before it is cut. */
const VERACITY_WARN_VALUE_CAP = 80;

/**
 * Values already warned about, so a store holding one unrecognized value does not print a
 * line per row.
 *
 * The warning has to stay loud, because clamping is a decision made on the operator's
 * behalf about whether a memory comes back. It does not have to repeat: recall calls
 * {@link weightForVeracity} once per candidate per query, so an unbounded warning there is
 * a flood that buries the one line the operator needed to read. First occurrence of each
 * distinct value speaks; the rest are the same fact.
 */
const warnedVeracities = new Set<string>();

/**
 * Reset the warned-value memory. Tests only, so one suite's clamp does not silence the
 * next suite's assertion that a clamp is reported.
 */
export function resetVeracityWarnings(): void {
	warnedVeracities.clear();
}

/**
 * Normalize anything stored, parsed, or handed in to a veracity, reporting the ones it does
 * not recognize.
 *
 * Case and surrounding space are noise from hand-written config and from other stores, so
 * `"STATED"` and `" stated "` are `stated`. Anything else is `unknown`, and the value is
 * named in a warning, because silently mapping an unrecognized label onto a 0.8 weight is
 * exactly how a memory nobody vouched for reads as one somebody did.
 */
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

/**
 * What a stored veracity is worth, for the recall path.
 *
 * Goes through {@link clampVeracity} so a column holding a value outside the vocabulary is
 * reported rather than scored on a guess, then indexes {@link VERACITY_WEIGHTS} outright.
 * There is no default: the vocabulary IS the table's keys, so every value it returns has a
 * weight, and a member added without one does not compile.
 */
export function weightForVeracity(raw: unknown, context = "recall"): number {
	return VERACITY_WEIGHTS[clampVeracity(raw, context)];
}

/**
 * The veracity to carry when several memories consolidate into one.
 *
 * The most common value wins, ignoring `unknown` while anything else is present, because an
 * unlabelled duplicate is an absence of evidence rather than evidence of absence. Ties go to
 * the LOWEST weight, so `true` and `false` in equal number consolidate to `false`: a claim
 * something checked and rejected is not settled by a claim something else accepted, and the
 * conservative reading is the one that keeps a wrong memory out of results.
 *
 * Unrecognized values are dropped rather than clamped. Clamping them would add `unknown`
 * votes that could outnumber the real ones and decide the outcome.
 */
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
