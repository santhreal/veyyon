/**
 * WHY: the progress bar drew its failed segment as `fail - error`, but the three counts are
 * disjoint and sum to `done` in every adapter that produces them (`traces.length - pass - error`
 * for the edit and deepswe readers, `totals.fail` for harbor). A run with more errors than failures
 * therefore drew no red at all, and every run with errors drew a bar shorter than the `done/nTotal`
 * count printed next to it: the widths said 60% while the label said 5/5.
 *
 * The class closed here: a rendered aggregate that disagrees with the number beside it. The widths
 * are read back out of the markup and summed, over a table of count mixes including the one that
 * hid the failures, so any future arithmetic that drops or double-counts a class turns this red.
 *
 * WHAT THIS DOES NOT CATCH: colour choice, the bar's own layout, and whether the counts the store
 * supplies are correct (the adapters and their suites own that).
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Progress } from "../../src/web/components/ui";

interface Counts {
	pass: number;
	fail: number;
	error: number;
	running: number;
	done: number;
	nTotal: number;
}

const MIXES: Array<[string, Counts]> = [
	["nothing started", { pass: 0, fail: 0, error: 0, running: 0, done: 0, nTotal: 10 }],
	["all passing", { pass: 10, fail: 0, error: 0, running: 0, done: 10, nTotal: 10 }],
	["passes and failures", { pass: 6, fail: 4, error: 0, running: 0, done: 10, nTotal: 10 }],
	["more errors than failures", { pass: 2, fail: 1, error: 2, running: 0, done: 5, nTotal: 5 }],
	["errors only", { pass: 0, fail: 0, error: 4, running: 0, done: 4, nTotal: 4 }],
	["half decided, half running", { pass: 3, fail: 1, error: 1, running: 5, done: 5, nTotal: 10 }],
	["more trials than the declared total", { pass: 6, fail: 0, error: 0, running: 0, done: 6, nTotal: 4 }],
];

/** Segment widths in percent, in markup order: pass, fail, error, running. */
function widths(counts: Counts): number[] {
	const markup = renderToStaticMarkup(<Progress run={counts} />);
	return [...markup.matchAll(/width:\s*([0-9.]+)%/g)].map(m => Number(m[1]));
}

describe("a progress bar", () => {
	it.each(MIXES)("draws every decided trial for %s", (_label, counts) => {
		const drawn = widths(counts);
		expect(drawn).toHaveLength(4);
		const total = Math.max(counts.nTotal, counts.done + counts.running, 1);
		const [pass, fail, error, running] = drawn;
		expect(pass).toBeCloseTo((100 * counts.pass) / total, 6);
		expect(fail).toBeCloseTo((100 * counts.fail) / total, 6);
		expect(error).toBeCloseTo((100 * counts.error) / total, 6);
		expect(running).toBeCloseTo((100 * counts.running) / total, 6);
		// The filled width is the count the label prints, never less.
		expect(pass + fail + error).toBeCloseTo((100 * counts.done) / total, 6);
	});

	it("draws its failures when a run has more errors than failures", () => {
		const [, fail, error] = widths({ pass: 2, fail: 1, error: 2, running: 0, done: 5, nTotal: 5 });
		expect(fail).toBeCloseTo(20, 6);
		expect(error).toBeCloseTo(40, 6);
	});

	it("prints the counts beside the bar, and a question mark for an unknown total", () => {
		expect(renderToStaticMarkup(<Progress run={MIXES[3][1]} />)).toContain("5");
		expect(
			renderToStaticMarkup(<Progress run={{ pass: 1, fail: 0, error: 0, running: 0, done: 1, nTotal: 0 }} />),
		).toContain("?");
	});
});
