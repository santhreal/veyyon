/**
 * WHY: the autoswarm setup console sized its value column from the values it was
 * currently showing, so the hint column moved sideways as the user adjusted a
 * knob.
 *
 * `Attempts` crossing 9 and `Certification` toggling to `off` each widen the
 * widest current value by a column, and every hint on screen shifted with it on
 * that one keystroke — the console appeared to twitch while nothing structural
 * changed. It also truncated its explanatory line at narrow widths, cutting the
 * clause that states where the metric comes from.
 *
 * The class this closes is a column measured from live content rather than from
 * the bounds the content can reach. The variant space is swept, not sampled:
 * every reachable breadth, every reachable attempts count, and both
 * certification states, at several terminal widths.
 *
 * What it does not catch: the goal row, whose value is free text and is windowed
 * to the caret rather than padded to a column.
 */
import { describe, expect, it } from "bun:test";
import { renderSetupConsole, SwarmSetupModel } from "@veyyon/coding-agent/autoresearch/setup-console";
import { MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme";

/** Colour functions as identity, so an assertion sees the columns themselves. */
const plainTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** Column the hint starts at on a row that has one, or -1. */
function hintColumn(line: string, hint: string): number {
	return line.indexOf(hint);
}

const HINTS = {
	breadth: "candidate arms per iteration",
	attempts: "retries before an arm is abandoned",
	certify: "arms cross-review before one is kept",
};

function frame(breadth: number, attempts: number, certify: boolean, width = 80): string[] {
	const model = new SwarmSetupModel({ goal: "make it faster", breadth, attempts, certify });
	return renderSetupConsole(model, width, plainTheme);
}

function hintColumns(lines: string[]): number[] {
	return Object.values(HINTS).map(hint => {
		const line = lines.find(candidate => candidate.includes(hint));
		return line ? hintColumn(line, hint) : -1;
	});
}

describe("the setup console columns hold still", () => {
	it("puts every hint in one column, at every reachable setting", () => {
		const baseline = hintColumns(frame(MIN_BREADTH, MIN_ATTEMPTS, true));
		// A hint that is missing reads as -1, so this also proves each row rendered.
		expect(baseline.every(column => column > 0)).toBe(true);
		expect(new Set(baseline).size).toBe(1);

		for (let breadth = MIN_BREADTH; breadth <= MAX_BREADTH; breadth += 1) {
			for (let attempts = MIN_ATTEMPTS; attempts <= MAX_ATTEMPTS; attempts += 1) {
				for (const certify of [true, false]) {
					const columns = hintColumns(frame(breadth, attempts, certify));
					expect(columns).toEqual(baseline);
				}
			}
		}
	});

	it("does not move a column when a value gets wider", () => {
		// The keystroke the defect showed up on: space over Certification, whose
		// value goes from two columns to three and used to take every hint on
		// screen with it. `on` is the narrowest value any row can hold and `off`
		// the widest, so this pair is the whole range of the effect.
		expect(hintColumns(frame(3, 3, true))).toEqual(hintColumns(frame(3, 3, false)));
		expect(hintColumns(frame(MIN_BREADTH, MIN_ATTEMPTS, true))).toEqual(
			hintColumns(frame(MAX_BREADTH, MAX_ATTEMPTS, false)),
		);
	});

	it("wraps every sentence instead of cutting it", () => {
		const narrow = frame(3, 3, true, 52).join("\n");
		// Each of these ends in the clause that carries the point, so a truncation
		// loses exactly the part worth reading.
		const flat = narrow.replace(/\s+/g, " ");
		expect(flat).toContain("The model derives the metric from your harness.");
		expect(flat).toContain("no pair reviews each other.");
		for (const line of frame(3, 3, true, 52)) {
			expect(line.length).toBeLessThanOrEqual(52);
		}
	});

	it("keeps every line inside the terminal at every width it is given", () => {
		// A line that escapes the width wraps in the host and pushes the exit
		// legend off the overlay, which is how a user gets stuck in the console.
		for (const width of [40, 52, 80, 120]) {
			const lines = frame(MAX_BREADTH, MAX_ATTEMPTS, false, width);
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(width);
			}
			// The key legend wraps rather than being cut, so the key that leaves the
			// console is on screen at every width — a truncated legend drops `esc
			// cancel` first, which is how a user gets stuck in it.
			expect(lines.at(-1)).toContain("esc cancel");
		}
	});
});
