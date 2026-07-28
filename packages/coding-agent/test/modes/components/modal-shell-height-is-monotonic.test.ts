/**
 * A modal must never get SMALLER when the terminal gets bigger.
 *
 * WHY THIS SUITE EXISTS. `computeModalDims` subtracted `vMargin` from both ends
 * unconditionally, and `withCompact` zeroed that margin at 24 rows and under. The
 * two rules met in the middle of ordinary window sizes and produced a cliff: a
 * 24-row terminal gave a full-screen card, and a 25-row terminal gave an 11-row
 * card whose body had no room for a single list row. The Agent Control Center on
 * a 25-row terminal, which is an ordinary split pane, showed an EMPTY box. That
 * is what "I opened /agents and it is useless" looks like from the inside.
 *
 * The property, not the numbers, is what these tests pin. Height is a step
 * function of terminal rows and the steps are allowed to move; what may never
 * happen again is a step DOWN. Each fix here was a separate discontinuity:
 *
 *   1. the margin taking rows the card could not spare (the 13-row cliff),
 *   2. compact mode handing back the whole screen and then taking it away,
 *   3. padding switching on faster than the card grew to pay for it (3 rows).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	computeModalDims,
	MODAL_SIZING_LARGE,
	MODAL_SIZING_MEDIUM,
	modalNeedsCompactPadding,
	planModalChrome,
	renderModalShell,
	withCompact,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import type { ModalSizing } from "@veyyon/coding-agent/modes/components/modal-shell";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const WIDTH = 100;

// The footer chips are styled while they are measured, so the chrome plan needs a
// theme even though nothing here asserts on colour.
beforeAll(async () => {
	await initTheme(false);
});

/** Card height at a terminal height, through the sizing path a card really uses. */
function cardHeight(rows: number, base: ModalSizing = MODAL_SIZING_LARGE): number {
	const sizing = withCompact(base, modalNeedsCompactPadding(rows, base));
	return computeModalDims(WIDTH, rows, sizing)?.modalHeight ?? 0;
}

/** Rows the card's BODY gets, which is what a list actually fills. */
function bodyRows(rows: number, base: ModalSizing = MODAL_SIZING_LARGE): number {
	const sizing = withCompact(base, modalNeedsCompactPadding(rows, base));
	const dims = computeModalDims(WIDTH, rows, sizing);
	if (!dims) return 0;
	return planModalChrome({
		sizing,
		modalHeight: dims.modalHeight,
		contentWidth: dims.contentWidth,
		shortcuts: [{ label: "esc close" }],
		hoveredShortcutId: null,
	}).maxBodyRows;
}

describe("Card height as the terminal grows", () => {
	/** The property. A taller terminal is never a shorter card. */
	it("never shrinks the card when the terminal gains a row", () => {
		const shrinks: string[] = [];
		let previous = 0;
		for (let rows = 8; rows <= 120; rows++) {
			const height = cardHeight(rows);
			if (height < previous) shrinks.push(`${rows} rows: ${previous} -> ${height}`);
			previous = height;
		}
		expect(shrinks).toEqual([]);
	});

	/** And the same for the body, which is the half a list can use. */
	it("never shrinks the body when the terminal gains a row", () => {
		const shrinks: string[] = [];
		let previous = 0;
		for (let rows = 8; rows <= 120; rows++) {
			const body = bodyRows(rows);
			if (body < previous) shrinks.push(`${rows} rows: ${previous} -> ${body}`);
			previous = body;
		}
		expect(shrinks).toEqual([]);
	});

	/** MEDIUM has its own margin and padding, so it gets the same guarantee. */
	it("never shrinks a MEDIUM card either", () => {
		const shrinks: string[] = [];
		let previous = 0;
		for (let rows = 8; rows <= 120; rows++) {
			const height = cardHeight(rows, MODAL_SIZING_MEDIUM);
			if (height < previous) shrinks.push(`${rows} rows: ${previous} -> ${height}`);
			previous = height;
		}
		expect(shrinks).toEqual([]);
	});
});

describe("The heights that were broken", () => {
	/**
	 * The exact regression. 25 rows produced an 11-row card: two borders, four
	 * rows of padding, two of tab strip and three of footer left NOTHING, so the
	 * roster rendered zero agents on a terminal that shows sixteen at 24 rows.
	 */
	it("gives a 25-row terminal a card with room for a list", () => {
		expect(cardHeight(25)).toBeGreaterThanOrEqual(24);
		expect(bodyRows(25)).toBeGreaterThanOrEqual(12);
	});

	/** The step at the compact boundary is zero rows, not thirteen. */
	it("hands a 25-row terminal at least what a 24-row terminal had", () => {
		expect(bodyRows(25)).toBeGreaterThanOrEqual(bodyRows(24));
	});

	/** A short terminal still gets the whole screen: the floor never overflows it. */
	it("never asks for more rows than the terminal has", () => {
		for (const rows of [8, 12, 16, 20, 24]) {
			expect(cardHeight(rows)).toBeLessThanOrEqual(rows);
		}
	});

	/** A tall terminal is unaffected: the floor is a floor, not a cap. */
	it("still gives a tall terminal its full margins", () => {
		expect(cardHeight(60)).toBe(60 - 2 * MODAL_SIZING_LARGE.vMargin);
		expect(cardHeight(100)).toBe(100 - 2 * MODAL_SIZING_LARGE.vMargin);
	});
});

describe("The compact-padding decision", () => {
	/**
	 * Compact is about whether the card has room to spare, not about how tall the
	 * terminal is. Reading it off the terminal is what made one extra row of
	 * window cost four rows of list.
	 */
	it("is compact exactly while the card is still pinned to its floor", () => {
		expect(modalNeedsCompactPadding(24, MODAL_SIZING_LARGE)).toBeTrue();
		expect(modalNeedsCompactPadding(30, MODAL_SIZING_LARGE)).toBeTrue();
		expect(modalNeedsCompactPadding(38, MODAL_SIZING_LARGE)).toBeTrue();
		expect(modalNeedsCompactPadding(39, MODAL_SIZING_LARGE)).toBeFalse();
		expect(modalNeedsCompactPadding(60, MODAL_SIZING_LARGE)).toBeFalse();
	});

	/**
	 * Compact sheds PADDING only. It used to zero the margin as well, which is
	 * what made leaving compact mode drop the card by two whole margins at once.
	 */
	it("keeps the margin when it strips the padding", () => {
		const compact = withCompact(MODAL_SIZING_LARGE, true);

		expect(compact.vPad).toBe(0);
		expect(compact.hPad).toBe(1);
		expect(compact.vMargin).toBe(MODAL_SIZING_LARGE.vMargin);
	});

	/**
	 * One owner, and the source proves it.
	 *
	 * The cliff was survivable in one component and invisible in three, because
	 * `ModelHub` and the settings picker each carried their own `height < 24`
	 * and neither moved when the shared rule was fixed. A threshold that depends
	 * on the card's own margins and padding cannot be restated as a bare number
	 * against the terminal: it is only ever right for one sizing. This fails the
	 * moment a fourth copy appears.
	 */
	it("is the only place a component decides a card is cramped", () => {
		const sources = new Bun.Glob("**/*.ts").scanSync({
			cwd: `${import.meta.dir}/../../../src`,
			absolute: true,
		});
		const offenders: string[] = [];
		for (const file of sources) {
			if (file.endsWith("/modal-shell.ts")) continue;
			const text = readFileSync(file, "utf8");
			// A bare comparison of a terminal height against the historical 24-row
			// threshold, which is what every hand-rolled copy looked like.
			if (/\b(?:term)?[Hh]eight\s*[<>]=?\s*24\b/.test(text)) offenders.push(file);
		}

		expect(offenders).toEqual([]);
	});
});

describe("Content-sized cards are unaffected", () => {
	/**
	 * The floor raises how much room a card MAY take, never how much it does. A
	 * dialog that asks for its content's height still gets exactly that, which is
	 * what keeps a four-line confirm from becoming a 24-row empty box on the
	 * terminal sizes where the floor is binding.
	 */
	it("still shrinks a card that asks for its content height", () => {
		const rows = 30;
		const sizing = withCompact(MODAL_SIZING_MEDIUM, modalNeedsCompactPadding(rows, MODAL_SIZING_MEDIUM));
		const dims = computeModalDims(WIDTH, rows, sizing);
		if (!dims) throw new Error("the area was too small to paint");
		const plan = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts: [{ label: "esc close" }],
			hoveredShortcutId: null,
		});

		const card = renderModalShell({
			areaWidth: WIDTH,
			areaHeight: rows,
			sizing,
			title: "Pick one",
			body: ["one", "two", "three"],
			shortcuts: [{ label: "esc close" }],
			preferredBodyRows: 3,
		});

		// `renderModalShell` paints the whole AREA, so the card is the run of rows
		// between its borders rather than the length of what it returned.
		const plain = card.lines.map(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
		const top = plain.findIndex(line => line.includes("┌"));
		const bottom = plain.findLastIndex(line => line.includes("└"));

		expect(bottom - top + 1).toBeLessThan(plan.maxBodyRows + plan.nonBody);
	});
});
