/**
 * A modal must never get SMALLER when the terminal gets bigger.
 *
 * WHY THIS SUITE EXISTS. `computeModalDims` subtracted `vMargin` from both ends
 * unconditionally, and the compact strip zeroed that margin at 24 rows and under.
 * The two rules met in the middle of ordinary window sizes and produced a cliff: a
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
 *
 * WHY THE OWNERSHIP CASES BELOW ARE NOT A SOURCE SCAN. This suite used to assert
 * one owner by grepping `src/` for `/\b(?:term)?[Hh]eight\s*[<>]=?\s*24\b/`. That
 * regex could only see a variable spelled `height` or `termHeight`, and
 * `model-picker.ts` had shipped `withCompact(MODAL_SIZING_MEDIUM, termRows < 24)`
 * the whole time: a live copy of the exact defect, invisible to the guard, keeping
 * its padding across every height from 24 to 32 where the shared rule says the card
 * is pinned to its floor. A scan for a spelling cannot close a class of spellings.
 * The decision is now unreachable: `sizingForArea` takes the AREA HEIGHT, computes
 * the rule itself, and its only boolean can compact a card EARLIER, never later. The
 * cases below assert that property over every exported sizing AND over a synthetic
 * grid of margins and paddings, so a sizing that does not exist yet, exported or
 * private, is already covered.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { ModalSizing } from "@veyyon/coding-agent/modes/components/modal-shell";
import * as modalShell from "@veyyon/coding-agent/modes/components/modal-shell";
import {
	computeModalDims,
	MODAL_SIZING_LARGE,
	MODAL_SIZING_MEDIUM,
	modalNeedsCompactPadding,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const WIDTH = 100;

// The footer chips are styled while they are measured, so the chrome plan needs a
// theme even though nothing here asserts on colour.
beforeAll(async () => {
	await initTheme(false);
});

/** Card height at a terminal height, through the sizing path a card really uses. */
function cardHeight(rows: number, base: ModalSizing = MODAL_SIZING_LARGE): number {
	const sizing = sizingForArea(base, rows);
	return computeModalDims(WIDTH, rows, sizing)?.modalHeight ?? 0;
}

/** Rows the card's BODY gets, which is what a list actually fills. */
function bodyRows(rows: number, base: ModalSizing = MODAL_SIZING_LARGE): number {
	const sizing = sizingForArea(base, rows);
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

/** Sizings the module exports, read off the namespace so a new one needs no edit here. */
function exportedSizings(): [string, ModalSizing][] {
	const exported = Object.entries(modalShell).filter((entry): entry is [string, ModalSizing] =>
		entry[0].startsWith("MODAL_SIZING_"),
	);
	if (exported.length === 0) throw new Error("no exported sizings: the enumeration lost its subject");
	return exported;
}

/**
 * Whether a sizing can pay for its own padding at the compact boundary.
 *
 * The boundary sits at `areaHeight - 2 * vMargin === MODAL_MIN_TALL_ROWS`, and the
 * card's floor when padded is `MODAL_MIN_TALL_ROWS + 4 * vPad` capped by the screen.
 * Turning padding on costs `2 * vPad` body rows at once while the card gains one row
 * per terminal row, so the floor is what covers that jump, and it can only do so if
 * the boundary height is at or above it: `2 * vMargin >= 4 * vPad`. A sizing with a
 * margin thinner than twice its padding steps DOWN at its own boundary no matter
 * where the boundary is put, because a card with no margin is the whole screen in
 * both states and the padding has nowhere to come from. That is geometry, not a
 * bug to fix, which is why it is a precondition on the table rather than a branch
 * in the code, and why the negative control below pins it.
 */
function canPayForItsPadding(sizing: ModalSizing): boolean {
	return sizing.vMargin >= 2 * sizing.vPad;
}

/**
 * Every sizing the class has to hold for: the exported ones plus a synthetic grid standing in for
 * the shapes that are not exported (a card whose sizing preset is module-private) and the ones
 * nobody has written yet.
 */
function everySizing(): ModalSizing[] {
	const synthetic: ModalSizing[] = [];
	for (let vMargin = 0; vMargin <= 12; vMargin++) {
		for (let vPad = 0; vPad <= 3; vPad++) {
			const sizing: ModalSizing = {
				widthPct: 0.8,
				maxWidth: 120,
				minWidth: 40,
				vMargin,
				hPad: 2,
				vPad,
				footerLines: 2,
			};
			if (canPayForItsPadding(sizing)) synthetic.push(sizing);
		}
	}
	return [...exportedSizings().map(([, sizing]) => sizing), ...synthetic];
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

	/**
	 * Every other sizing gets the same guarantee, and gets it without anyone
	 * remembering to add a case: `everySizing()` reads the exported ones off the
	 * module and adds a grid that stands in for the private and the not-yet-written.
	 * MEDIUM used to be the only sibling listed here, which is how `MODAL_SIZING_SETTINGS`
	 * and `MANAGER_SIZING` went untested.
	 */
	it("never shrinks a card of any other sizing either", () => {
		const shrinks: string[] = [];
		for (const sizing of everySizing()) {
			let previous = 0;
			for (let rows = 8; rows <= 120; rows++) {
				const height = cardHeight(rows, sizing);
				if (height < previous) {
					shrinks.push(`vMargin ${sizing.vMargin} vPad ${sizing.vPad} at ${rows} rows: ${previous} -> ${height}`);
				}
				previous = height;
			}
		}
		expect(shrinks).toEqual([]);
	});

	/** And the body, for every one of them. */
	it("never shrinks the body of a card of any other sizing", () => {
		const shrinks: string[] = [];
		for (const sizing of everySizing()) {
			let previous = 0;
			for (let rows = 8; rows <= 120; rows++) {
				const body = bodyRows(rows, sizing);
				if (body < previous) {
					shrinks.push(`vMargin ${sizing.vMargin} vPad ${sizing.vPad} at ${rows} rows: ${previous} -> ${body}`);
				}
				previous = body;
			}
		}
		expect(shrinks).toEqual([]);
	});

	/**
	 * The precondition the guarantee rests on, asserted against the shipped table.
	 *
	 * A sizing whose margin is thinner than twice its padding cannot be monotonic,
	 * so declaring one is the way to reintroduce the cliff without touching a line
	 * of the engine. Every exported sizing satisfies it today (LARGE 7/2, MEDIUM 4/1,
	 * SETTINGS 3/1, and the private MANAGER_SIZING 7/1); the moment one does not,
	 * this fails and names it, which is the only warning anyone gets.
	 */
	it("ships no sizing that cannot pay for its own padding", () => {
		const offenders = exportedSizings()
			.filter(([, sizing]) => !canPayForItsPadding(sizing))
			.map(([name, sizing]) => `${name}: vMargin ${sizing.vMargin} < 2 * vPad ${sizing.vPad}`);
		expect(offenders).toEqual([]);
	});

	/**
	 * The negative control for that precondition, so it stays a fact rather than
	 * folklore. A zero-margin card with padding really does lose body rows at its
	 * boundary, which is what makes the rule above worth enforcing; if this ever
	 * stops stepping down, the geometry changed and the precondition can be relaxed
	 * on purpose instead of by accident.
	 */
	it("still steps down for a sizing that cannot, which is why the rule exists", () => {
		const illegal: ModalSizing = {
			widthPct: 0.8,
			maxWidth: 120,
			minWidth: 40,
			vMargin: 0,
			hPad: 2,
			vPad: 1,
			footerLines: 2,
		};
		expect(canPayForItsPadding(illegal)).toBeFalse();
		expect(bodyRows(25, illegal)).toBeLessThan(bodyRows(24, illegal));
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
		const compact = sizingForArea(MODAL_SIZING_LARGE, 10);

		expect(compact.vPad).toBe(0);
		expect(compact.hPad).toBe(1);
		expect(compact.vMargin).toBe(MODAL_SIZING_LARGE.vMargin);
	});

	/**
	 * A caller cannot supply the decision, only ask for it earlier.
	 *
	 * This is the ownership guarantee, stated as behaviour rather than as a scan
	 * for a spelling. `sizingForArea` applies the height rule itself, so for every
	 * height where the card is pinned to its floor the result is compact whatever
	 * the caller passed, and the force flag can never carry the boundary later,
	 * which is the only direction the cliff lives in.
	 */
	it("applies the height rule whatever the caller asks for", () => {
		const late: string[] = [];
		for (const sizing of everySizing()) {
			for (let rows = 8; rows <= 120; rows++) {
				const pinned = modalNeedsCompactPadding(rows, sizing);
				if (!pinned) continue;
				for (const force of [false, true]) {
					const resolved = sizingForArea(sizing, rows, force);
					if (resolved.vPad !== 0 || resolved.hPad !== 1) {
						late.push(`vMargin ${sizing.vMargin} vPad ${sizing.vPad} at ${rows} rows, force ${force}`);
					}
				}
			}
		}
		expect(late).toEqual([]);
	});

	/**
	 * And a roomy card keeps its padding, so the strip is exactly the rule's answer
	 * plus the force, never a caller's own threshold. `sizingForArea` returns the
	 * sizing it was given, unchanged, for every height the rule leaves alone.
	 */
	it("hands a roomy card back its own sizing", () => {
		const surprises: string[] = [];
		for (const sizing of everySizing()) {
			for (let rows = 8; rows <= 120; rows++) {
				if (modalNeedsCompactPadding(rows, sizing)) continue;
				if (sizingForArea(sizing, rows) !== sizing) {
					surprises.push(`vMargin ${sizing.vMargin} vPad ${sizing.vPad} at ${rows} rows`);
				}
			}
		}
		expect(surprises).toEqual([]);
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
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, rows);
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
