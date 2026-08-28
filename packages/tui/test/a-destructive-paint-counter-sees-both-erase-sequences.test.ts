/**
 * The instrument five paint suites measure with, measured itself.
 *
 * WHAT THIS CLOSES. `countDestructivePaints` is now the only counter of ED2 and
 * ED3 in the repo, and every suite that asserts a frame was NOT destructive
 * reads it. That makes a broken counter indistinguishable from a clean engine:
 * every one of those suites would report zero and pass. Before the counter had
 * one owner the same risk was spread across five hand-rolled copies, one of
 * which counted ED3 while its sibling four rows away counted ED2 as well.
 *
 * A live negative control already exists for ED3 -- the busy-turn suite forces
 * `requestRender(true, { clearScrollback: true })` and asserts the counters
 * move -- but it asserts the SUM `clears + erases > 0`, so ED2 alone was pinned
 * by nothing: `expect(busy.clears).toBe(0)` was green whether or not that half
 * of the instrument worked. That is a counter that can only ever read zero,
 * which is the thing the control exists to prevent.
 *
 * THE CLASS, not the incident. Each sequence is counted independently, each is
 * counted per OCCURRENCE rather than per write (two erases in one write are two
 * erases), the wrapped terminal still receives every byte it was sent, and the
 * byte total is the bytes actually written. Those four are the whole contract
 * the paint suites lean on, and each is pinned separately so a mutation to one
 * cannot hide behind another.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about which frames the ENGINE emits
 * those sequences on -- that is what the paint suites are for -- and nothing
 * about whether an emulator tore while drawing them, which is not observable
 * from these bytes. It also does not pin the readings' relationship to a
 * measurement window; a scenario subtracting two readings owns that.
 */
import { describe, expect, it } from "bun:test";
import { VirtualTerminal } from "@veyyon/render-oracle";
import { countDestructivePaints } from "./helpers/destructive-paints";

const ED2 = "\x1b[2J";
const ED3 = "\x1b[3J";

const wrapped = () => {
	const term = new VirtualTerminal(20, 5, 100);
	return { term, paints: countDestructivePaints(term) };
};

describe("a destructive-paint counter", () => {
	it("starts at zero", () => {
		const { paints } = wrapped();

		expect([paints.clears(), paints.erases(), paints.bytes()]).toEqual([0, 0, 0]);
	});

	it("counts a viewport clear without counting a scrollback erase", () => {
		const { term, paints } = wrapped();

		term.write(`${ED2}\x1b[Hplain`);

		expect([paints.clears(), paints.erases()]).toEqual([1, 0]);
	});

	it("counts a scrollback erase without counting a viewport clear", () => {
		const { term, paints } = wrapped();

		term.write(`\x1b[H${ED3}plain`);

		expect([paints.clears(), paints.erases()]).toEqual([0, 1]);
	});

	it("counts both when one write carries both", () => {
		const { term, paints } = wrapped();

		// The shipped full-repaint sequence writes them together.
		term.write(`${ED2}\x1b[H${ED3}`);

		expect([paints.clears(), paints.erases()]).toEqual([1, 1]);
	});

	/** A per-write counter reads this as one, which merges two flashes into one. */
	it("counts occurrences, not writes", () => {
		const { term, paints } = wrapped();

		term.write(`${ED3}rows${ED3}more${ED3}`);

		expect(paints.erases()).toBe(3);
	});

	it("accumulates across writes", () => {
		const { term, paints } = wrapped();

		term.write(ED2);
		term.write("ordinary content");
		term.write(ED3);
		term.write(`${ED2}${ED3}`);

		expect([paints.clears(), paints.erases()]).toEqual([2, 2]);
	});

	it("counts nothing for a frame that erases nothing", () => {
		const { term, paints } = wrapped();

		// A differential repaint: cursor moves and line erases, no ED2/ED3.
		term.write("\x1b[3;1H\x1b[Kreplacement row\x1b[2K");

		expect([paints.clears(), paints.erases()]).toEqual([0, 0]);
	});

	it("totals the bytes it was given", () => {
		const { term, paints } = wrapped();
		const first = `${ED2}abc`;
		const second = "de";

		term.write(first);
		term.write(second);

		expect(paints.bytes()).toBe(first.length + second.length);
	});

	/**
	 * THE ONE THAT MATTERS MOST. The counter replaces `term.write`, so a wrapper
	 * that forgot to forward would leave every paint suite driving a terminal
	 * that never receives a frame -- and their assertions are mostly that
	 * nothing destructive happened, which an empty terminal satisfies.
	 */
	it("still delivers every byte to the terminal it wrapped", () => {
		const { term, paints } = wrapped();

		term.write("first row\r\nsecond row");

		expect(term.getViewport()[0]?.trimEnd()).toBe("first row");
		expect(term.getViewport()[1]?.trimEnd()).toBe("second row");
		expect(paints.bytes()).toBeGreaterThan(0);
	});
});
