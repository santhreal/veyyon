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

/** Whether the answer holds `expected` as text, ignoring case and spacing. */
export function answerHasText(answer: string, expected: string): boolean {
	return normalizeText(answer).includes(normalizeText(expected));
}

/**
 * Every number written in the answer: thousands separators dropped, a leading currency sign or a
 * trailing percent ignored, `-` kept as a sign only where it starts the number.
 */
export function numbersIn(answer: string): number[] {
	const matches = answer.replaceAll(/(\d),(?=\d{3}\b)/g, "$1").match(/(?<![\d.])-?\d+(?:\.\d+)?/g) ?? [];
	return matches.map(Number).filter(Number.isFinite);
}

/** Whether the answer states `expected`, within `tolerance`. */
export function answerHasNumber(answer: string, expected: number, tolerance = 0.005): boolean {
	return numbersIn(answer).some(value => Math.abs(value - expected) <= tolerance);
}
