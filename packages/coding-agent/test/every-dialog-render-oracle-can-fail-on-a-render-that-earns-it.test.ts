/**
 * WHY THIS SUITE EXISTS:
 * Ten guarantees over the two surfaces that ask a question, and six of their ledgers in the sweep beside
 * this file are pinned empty. An empty ledger is a strong claim, and it is worthless if the check behind
 * it cannot disagree with anything. Two of the ten compare one render against another, two read a card's
 * geometry off its own border glyphs, and one searches the rows for a string; each is the kind of check
 * that is easy to write so it never fails.
 *
 * WHAT IT ASSERTS:
 * For each of the ten ids, a state that earns exactly that failure produces exactly it, and the clean
 * state it was derived from produces nothing. The defect is crafted on the state rather than on the
 * labels, because a label that provokes a real defect is a defect the sweep should be reporting; what is
 * under test here is the check.
 *
 * A comparison guarantee gets three crafts: rows that differ in content, rows that are one short, and
 * rows that are one long. The first walks the loop in `firstDifference` and the other two walk the length
 * test after it, and a suite carrying only the first goes green when that test is replaced by an
 * unconditional agreement. That mutation was run against the markdown registry, which had the same shape
 * and the same hole.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Whether a guarantee is the right guarantee for the surface. It proves each check disagrees with a state
 * that violates it; whether a component can reach that state is what the sweep is for.
 *
 * MUTATION GATE, run and recorded across this file and the sweep beside it:
 * - `plainDialogRow` returning its argument unchanged: 1 fail. That mutation was green on two earlier
 *   runs, because nothing depended on stripping a row: the card border is unstyled in the render, so the
 *   body-row scan found its glyphs either way, and blinding it only moved the two card guarantees from
 *   inspected to skipped, which the sweep accepted. Two changes closed it. The sweep now asserts both
 *   card guarantees read the card on every render, because a skipped guarantee is not a satisfied one;
 *   and the home-path guarantee gained a craft whose path is interrupted by a style boundary, which is
 *   the case a scan of the raw bytes cannot see.
 * - `firstDifference` returning -1 unconditionally: 4 fail.
 * - `cardBodyRows` returning every row rather than the ones carrying a left edge: 7 fail.
 * - the ask dialog's own tab replacement removed, so its labels forward a raw tab: 1 fail, which is the
 *   hook-selector-only ledger row gaining a surface.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import {
	DIALOG_RENDER_ORACLE_GUARANTEES,
	DIALOG_RENDER_ORACLES,
	type DialogRenderOracleFrameState,
	type DialogRenderOracleGuarantee,
	evaluateAllDialogRenderOracles,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import { type DialogRenderCase, dialogStateFor } from "./helpers/defect-oracles";

/**
 * The state every craft is derived from: the ask dialog mounted with the label set a real question uses,
 * painted at 80 columns.
 *
 * `plain` rather than one of the hostile sets, because a baseline has to be clean for a craft to be the
 * only reason a guarantee fails, and every hostile set carries a live ledger row.
 */
const BASELINE: DialogRenderCase = { surface: "askDialog", fixture: "plain", width: 80 };

type Craft = (state: DialogRenderOracleFrameState) => DialogRenderOracleFrameState;

/**
 * Replace the painted rows, and move every comparison arm with them.
 *
 * A craft that changed `rows` alone would earn several failures rather than one: both comparison arms
 * would disagree with the corrupted rows. Corrupting a row is the defect being modelled; disagreeing
 * with itself is not.
 */
function withRows(state: DialogRenderOracleFrameState, rows: readonly string[]): DialogRenderOracleFrameState {
	return { ...state, rows, rowsFromASecondRender: rows, rowsAfterAResize: rows };
}

/** A card body row of exactly the given painted width, with both edges drawn. */
function bodyRow(cells: string, width: number): string {
	const inner = cells.padEnd(Math.max(0, width - 2), " ").slice(0, Math.max(0, width - 2));
	return `│${inner}│`;
}

/**
 * Most crafts paint one row.
 *
 * A card of one body row puts the width-uniformity guarantee out of scope, because a single width cannot
 * disagree with itself. That is what keeps a craft attributable: a two-row craft that changed a row's
 * bytes also changed its width, so it earned the uniformity failure as well as the one it was written
 * for, and the suite could not tell which check had caught the defect.
 */
const DEFECTS: Readonly<Record<DialogRenderOracleGuarantee, readonly Craft[]>> = {
	everyPaintedRowFitsTheWidthItWasRenderedFor: [
		// One row one cell over the width it was rendered for.
		state => withRows(state, [bodyRow("head", state.width + 1)]),
	],
	noPaintedRowCarriesALineBreak: [state => withRows(state, ["\u2502head\ntail\u2502"])],
	noPaintedRowForwardsARawTab: [state => withRows(state, ["\u2502a\tb\u2502"])],
	noPaintedRowSeversAnEscapeSequence: [
		// An ESC followed by another ESC begins no sequence, where an ESC followed by a printable byte
		// would be read as a complete two-byte escape and pass.
		state => withRows(state, ["\u2502\x1b\x1b[39mhead\u2502"]),
	],
	noLabelSuppliedEscapeSurvivesIntoARow: [
		// A row carrying a sequence the labels declare they supplied.
		state => ({
			...withRows(state, ["\u2502\x1b[31mred\x1b[39m\u2502"]),
			labelSuppliedEscapes: ["\x1b[31m"],
		}),
	],
	everyRowOfTheCardIsTheSameWidth: [
		// Two body rows of different widths, so the card's right edge steps in. Both fit the terminal and
		// both close their edge, so the width difference is the only thing wrong.
		state => withRows(state, [bodyRow("head", 40), bodyRow("tail", 30)]),
	],
	theCardBorderIsClosedOnEveryBodyRow: [
		// A body row that opens a left edge and never closes it.
		state => withRows(state, ["\u2502tail with no right edge"]),
	],
	aSecondRenderPaintsTheSameRows: [
		// Content differs at a shared index, which walks the loop.
		state => ({ ...withRows(state, [bodyRow("head", 40)]), rowsFromASecondRender: [bodyRow("heaD", 40)] }),
		// One row short, which walks the length test.
		state => ({
			...withRows(state, [bodyRow("head", 40), bodyRow("tail", 40)]),
			rowsFromASecondRender: [bodyRow("head", 40)],
		}),
		// One row long, which walks the same test from the other side.
		state => ({
			...withRows(state, [bodyRow("head", 40)]),
			rowsFromASecondRender: [bodyRow("head", 40), bodyRow("tail", 40)],
		}),
	],
	aResizedComponentReturnsToItsFirstRows: [
		state => ({ ...withRows(state, [bodyRow("head", 40)]), rowsAfterAResize: [bodyRow("heaD", 40)] }),
		state => ({
			...withRows(state, [bodyRow("head", 40), bodyRow("tail", 40)]),
			rowsAfterAResize: [bodyRow("head", 40)],
		}),
		state => ({
			...withRows(state, [bodyRow("head", 40)]),
			rowsAfterAResize: [bodyRow("head", 40), bodyRow("tail", 40)],
		}),
	],
	noRowPaintsTheHomeDirectoryPath: [
		// A row painting the home directory in full, with a home to leak.
		state => ({
			...withRows(state, [bodyRow("/home/oracle/projects/thing.ts", 40)]),
			homeDirectory: "/home/oracle",
		}),
		// The same leak with a style boundary inside the path. A scan of the raw row cannot see it,
		// because the bytes of the home directory are not contiguous there; the cells are. This is the
		// craft that makes stripping the row load-bearing rather than decorative, and a renderer that
		// styles a path segment differently from the rest of it produces exactly this shape.
		state => ({
			...withRows(state, ["\u2502/home/\x1b[39moracle/projects/thing.ts\u2502"]),
			homeDirectory: "/home/oracle",
		}),
	],
};

/**
 * The states a guarantee declares out of scope, with the reason read off the state.
 *
 * A guarantee that applies to everything is a guarantee whose scope nobody has thought about; a scope
 * asserted here is one somebody stated and can be shown.
 */
const STAND_DOWNS: readonly { id: DialogRenderOracleGuarantee; spec: DialogRenderCase; why: string }[] = [
	{
		id: "noLabelSuppliedEscapeSurvivesIntoARow",
		spec: { surface: "askDialog", fixture: "plain", width: 80 },
		why: "the labels supply no escape sequence for a row to carry",
	},
	{
		id: "noPaintedRowSeversAnEscapeSequence",
		spec: { surface: "hookSelector", fixture: "empty", width: 40 },
		why: "no painted row carries an escape byte at all",
	},
];

describe("every dialog render oracle can fail on a render that earns it", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	it("judges the baseline render clean", () => {
		const evaluation = evaluateAllDialogRenderOracles(dialogStateFor(BASELINE));
		expect(evaluation.failures).toEqual([]);
		expect(evaluation.blind).toEqual([]);
	});

	it.each(
		DIALOG_RENDER_ORACLE_GUARANTEES.flatMap(id =>
			DEFECTS[id].map((craft, index) => [`${id} craft ${index}`, id, craft] as const),
		),
	)("%s reports the defect it owns and nothing else", (_label, id, craft) => {
		const clean = dialogStateFor(BASELINE);
		const broken = craft(clean);

		// A craft that changed nothing would pass as a clean baseline, which is the failure mode this
		// suite exists to rule out. `widthOf` is a function and is not part of the comparison.
		const shape = (state: DialogRenderOracleFrameState): string =>
			JSON.stringify([
				state.rows,
				state.rowsFromASecondRender,
				state.rowsAfterAResize,
				state.labelSuppliedEscapes,
				state.homeDirectory,
			]);
		expect(shape(broken)).not.toBe(shape(clean));

		const before = evaluateAllDialogRenderOracles(clean);
		expect(before.failures.map(failure => failure.oracle)).not.toContain(id);

		const after = evaluateAllDialogRenderOracles(broken);
		expect(after.failures.map(failure => failure.oracle)).toEqual([id]);
		expect(after.failures[0]?.message.length ?? 0).toBeGreaterThan(0);
	});

	it.each(STAND_DOWNS.map(entry => [`${entry.id} stands down when ${entry.why}`, entry] as const))(
		"%s",
		(_label, entry) => {
			const state = dialogStateFor(entry.spec);
			expect(DIALOG_RENDER_ORACLES[entry.id].appliesTo(state)).toBe(false);
			expect(evaluateAllDialogRenderOracles(state).skipped).toContain(entry.id);
		},
	);

	it("declares a guarantee for every id and an id for every guarantee", () => {
		expect(Object.keys(DIALOG_RENDER_ORACLES).sort()).toEqual([...DIALOG_RENDER_ORACLE_GUARANTEES].sort());
		for (const id of DIALOG_RENDER_ORACLE_GUARANTEES) {
			expect(DIALOG_RENDER_ORACLES[id].guarantee.length).toBeGreaterThan(40);
		}
	});

	it("crafts a defect for every guarantee, so a new guarantee arrives unproven and red", () => {
		expect(Object.keys(DEFECTS).sort()).toEqual([...DIALOG_RENDER_ORACLE_GUARANTEES].sort());
		for (const id of DIALOG_RENDER_ORACLE_GUARANTEES) {
			expect(DEFECTS[id].length).toBeGreaterThan(0);
		}
	});

	it("gives every comparison guarantee a craft for each path through its difference walk", () => {
		const comparisons: readonly DialogRenderOracleGuarantee[] = [
			"aSecondRenderPaintsTheSameRows",
			"aResizedComponentReturnsToItsFirstRows",
		];
		for (const id of comparisons) {
			expect(DEFECTS[id].length, `${id} needs a craft per path`).toBeGreaterThanOrEqual(3);
		}
	});
});
