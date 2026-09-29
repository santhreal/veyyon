/**
 * How a kit task is graded: named checks over the state its services recorded and the agent's
 * final answer.
 *
 * A check reads what the application holds at the end of the trial (an order placed, a setting
 * saved, a message sent), not what the page looked like, so an agent is scored on what it did.
 * A task passes when every check passes; the fraction that pass is its partial credit, which shows
 * how far a failed trial got.
 */

export interface Check<State> {
	/** Stable across versions: a report compares check pass rates by id. */
	readonly id: string;
	readonly description: string;
	readonly pass: (state: State, answer: string) => boolean;
}

export interface CheckOutcome {
	readonly id: string;
	readonly description: string;
	readonly passed: boolean;
	/** What the check threw, when it threw; a check that throws fails. */
	readonly error?: string;
}

export interface Grade {
	/** 1 when every check passed, else 0. */
	readonly reward: 0 | 1;
	/** The fraction of checks that passed. */
	readonly partial: number;
	readonly outcomes: readonly CheckOutcome[];
}

export function gradeChecks<State>(checks: readonly Check<State>[], state: State, answer: string): Grade {
	if (checks.length === 0) throw new Error("a task with no checks cannot be graded");
	const outcomes = checks.map((check): CheckOutcome => {
		try {
			return { id: check.id, description: check.description, passed: check.pass(state, answer) === true };
		} catch (error) {
			return {
				id: check.id,
				description: check.description,
				passed: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
	const passed = outcomes.filter(outcome => outcome.passed).length;
	return { reward: passed === outcomes.length ? 1 : 0, partial: passed / outcomes.length, outcomes };
}

/** Lowercase, straight quotes, one space between words. */
export function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replaceAll(/[\u2018\u2019]/g, "'")
		.replaceAll(/[\u201c\u201d]/g, '"')
		.replaceAll(/\s+/g, " ")
		.trim();
}

/** A letter or digit in any script: what a name must not run into on either side. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Whether the answer names `expected` as a whole term, ignoring case and spacing: "East" is not
 * named by "least", nor "Tent 1" by "Tent 12". A side of `expected` that ends in a letter or digit
 * must meet something else in the answer. An `expected` that normalizes to nothing throws, so the
 * check fails instead of passing every answer, the empty one included.
 */
export function answerHasText(answer: string, expected: string): boolean {
	const needle = normalizeText(expected);
	if (needle === "") throw new Error("the expected text is empty, and every answer holds it");
	const haystack = normalizeText(answer);
	const openStart = !WORD_CHARACTER.test(needle.charAt(0));
	const openEnd = !WORD_CHARACTER.test(needle.charAt(needle.length - 1));
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		if (
			(openStart || !WORD_CHARACTER.test(haystack.charAt(at - 1))) &&
			(openEnd || !WORD_CHARACTER.test(haystack.charAt(at + needle.length)))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Whether the answer names `expected` and none of `others`, the candidates a trial showed beside
 * it: an answer that hedges ("C, or maybe D") fails. `names` sets what naming is, `answerHasText`
 * unless a value has spellings of its own. An entry of `others` equal to `expected` is skipped, so a
 * caller may pass every candidate. An entry that holds `expected`, or that `expected` holds, as
 * whole terms throws: no answer could name the one without the other.
 */
export function answerNamesOnly(
	answer: string,
	expected: string,
	others: readonly string[],
	names: (answer: string, name: string) => boolean = answerHasText,
): boolean {
	const rivals = others.filter(other => normalizeText(other) !== normalizeText(expected));
	for (const other of rivals) {
		if (answerHasText(other, expected) || answerHasText(expected, other)) {
			throw new Error(`"${expected}" and "${other}" hold one another, so no answer names one alone`);
		}
	}
	return names(answer, expected) && !rivals.some(other => names(answer, other));
}

/**
 * A number as an answer writes it. The digits must not continue a word (`W07`, `SK-A5HNU`,
 * `ORD-1042`): digits after a letter, or after a hyphen that follows a letter, belong to an
 * identifier. A `-` is a sign only when nothing word-like stands before it and it touches the
 * digits or a currency sign before them (`-40`, `-$12.30`), so `2026-05-03` and `10-15` read as
 * positive parts and a spaced dash (`Groceries - $312.40`) is no sign.
 */
const NUMBER = /(?:(?<![\p{L}\p{N}_.])-\p{Sc}?)?(?<![\p{L}\p{N}_.]|[\p{L}_]-)\d+(?:\.\d+)?/gu;

/**
 * Every number written in the answer: thousands separators dropped, a currency sign or a trailing
 * percent ignored, a minus sign (`-`, `−`, or `–` before the digits) kept as a sign where it starts
 * the number, and digits inside an identifier left out.
 */
export function numbersIn(answer: string): number[] {
	const matches =
		answer
			.replaceAll(/[\u2212\u2013]/g, "-")
			.replaceAll(/(\d),(?=\d{3}\b)/g, "$1")
			.match(NUMBER) ?? [];
	return matches.map(match => Number(match.replace(/\p{Sc}/u, ""))).filter(Number.isFinite);
}

/**
 * How a stated figure's sign counts. `exact` takes `-312.40` for another figure than `312.40`;
 * `either` compares magnitudes, for a figure a page prints with a sign an answer may copy or drop
 * (a ledger showing spend as `-$312.40`). A check that accepts either sign passes `either`.
 */
export type AnswerSign = "exact" | "either";

/** Whether the answer states `expected`, within `tolerance`. */
export function answerHasNumber(
	answer: string,
	expected: number,
	tolerance = 0.005,
	sign: AnswerSign = "exact",
): boolean {
	return answerStatesOnly(answer, expected, [], tolerance, sign);
}

/**
 * Whether the answer states `expected` and none of `others`, the figures a trial showed beside it
 * (a total before a correction, a sum that counts pending charges), each within `tolerance`. An
 * entry of `others` within `tolerance` of `expected` is skipped.
 */
export function answerStatesOnly(
	answer: string,
	expected: number,
	others: readonly number[],
	tolerance = 0.005,
	sign: AnswerSign = "exact",
): boolean {
	const size = sign === "either" ? Math.abs : (value: number) => value;
	const stated = numbersIn(answer).map(size);
	const target = size(expected);
	return (
		stated.some(value => Math.abs(value - target) <= tolerance) &&
		!others.some(other => {
			const figure = size(other);
			return Math.abs(figure - target) > tolerance && stated.some(value => Math.abs(value - figure) <= tolerance);
		})
	);
}
