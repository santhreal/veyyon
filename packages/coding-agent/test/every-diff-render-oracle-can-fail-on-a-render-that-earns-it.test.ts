/**
 * WHY THIS SUITE EXISTS:
 * Ten guarantees over the diff renderer, and eight of their ledgers in the sweep beside this file are
 * pinned empty. An empty ledger is a strong claim, and it is worthless if the check behind it cannot
 * disagree with anything. Four of the ten compare one render against another and one compares a row
 * against its own input, and a comparison is the easiest kind of check to write so it can never fail.
 *
 * WHAT IT ASSERTS:
 * For each of the ten ids, a state that earns exactly that failure produces exactly it, and the clean
 * state it was derived from produces nothing. The defect is crafted on the state, not on the diff text,
 * because a diff that provokes a real defect is a defect the sweep should be reporting; what is under
 * test here is the check.
 *
 * A comparison guarantee gets three crafts: rows that differ in content, rows that are one short, and
 * rows that are one long. The first walks the loop in `firstDifference`, the other two walk the length
 * test after it, and a suite carrying only the first goes green when that test is replaced by an
 * unconditional agreement. That mutation was run against the markdown registry, which had the same
 * shape and the same hole.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Whether a guarantee is the right guarantee for the renderer. It proves each check disagrees with a
 * state that violates it; whether the renderer can reach that state is what the sweep is for.
 *
 * MUTATION GATE, run and recorded:
 * - the reserved gutter floor dropped from 3 to 0: sweep 1 fail.
 * - the line-number dedup removed from the renderer: sweep 1 fail.
 * - `firstDifference` returning -1 unconditionally: 6 fail here.
 * - `plainDiffRow` returning its argument unchanged: 2 fail here.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	DIFF_RENDER_ORACLE_GUARANTEES,
	DIFF_RENDER_ORACLES,
	type DiffRenderOracleFrameState,
	type DiffRenderOracleGuarantee,
	evaluateAllDiffRenderOracles,
	plainDiffRow,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import { type DiffRenderCase, diffStateFor } from "./helpers/defect-oracles";

/**
 * The state every craft is derived from: a real render of a single-line replacement with space
 * indentation, through a TypeScript path so the highlighter runs.
 *
 * `spaceIndent` rather than `tabIndent`, because the tab fixture carries the one live streaming defect
 * and a baseline has to be clean for a craft to be the only reason a guarantee fails.
 */
const BASELINE: DiffRenderCase = { fixture: "spaceIndent", filePath: 1 };

type Craft = (state: DiffRenderOracleFrameState) => DiffRenderOracleFrameState;

/**
 * Replace the rendered rows, and move every comparison arm with them.
 *
 * A craft that changed `rows` alone would earn four failures rather than one: the second render and
 * every prefix would disagree with the corrupted rows, and the content check would report the synthetic
 * row as having lost the real input's content. Corrupting a row is the defect being modelled;
 * disagreeing with itself is not, so the input rows become gap rows that claim no content and the
 * content guarantee reads nothing rather than reporting a craft it was not written for.
 */
function withRows(state: DiffRenderOracleFrameState, rows: readonly string[]): DiffRenderOracleFrameState {
	return {
		...state,
		rows,
		rowsFromASecondRender: rows,
		prefixRenders: rows.map((_, index) => rows.slice(0, index + 1)),
		inputRows: rows.map(raw => ({ raw, marker: null, lineNumber: "", content: "" })),
	};
}

const DEFECTS: Readonly<Record<DiffRenderOracleGuarantee, readonly Craft[]>> = {
	everyInputRowProducesExactlyOneRow: [
		// One row short of its input, with every comparison arm agreeing, so only the count is wrong.
		state => ({
			...withRows(state, state.rows.slice(0, -1)),
			// The input rows keep their count, which is the only thing this craft changes.
			inputRows: state.inputRows.map(row => ({ ...row, marker: null, lineNumber: "", content: "" })),
		}),
	],
	noRenderedDiffRowCarriesALineBreak: [state => withRows(state, ["  1│ok", "  2│two\nrows"])],
	noRenderedDiffRowForwardsARawTab: [state => withRows(state, ["  1│ok", "  2│a\tb"])],
	noRenderedDiffRowSeversAnEscapeSequence: [state => withRows(state, ["  1│ok", "  2│text \x1b[1;3"])],
	everyNumberedRowPaintsItsGutterAtTheSameColumn: [state => withRows(state, ["  1│aligned", "    12│shifted"])],
	noRowRepeatsThePreviousRowsLineNumber: [state => withRows(state, [" -7│old", " +7│new"])],
	everyRowKeepsThePrintableContentItWasGiven: [
		// The input rows are kept; the row that should carry the first one's content paints something
		// else. The gutter the real row painted is kept byte for byte, so the alignment guarantee has
		// nothing to say about it and this craft earns exactly one failure.
		state => {
			const real = plainDiffRow(state.rows[0] ?? "");
			const corrupted = `${real.slice(0, real.indexOf("│") + 1)}unrelated`;
			const rows = [corrupted, ...state.rows.slice(1)];
			return {
				...state,
				rows,
				rowsFromASecondRender: rows,
				prefixRenders: state.prefixRenders.map((prefix, index) =>
					index === 0 ? [corrupted] : [corrupted, ...prefix.slice(1)],
				),
			};
		},
	],
	noContentSuppliedEscapeSurvivesIntoARow: [
		// The guarantee only applies when the diff carried an escape byte, so both halves move.
		state => ({
			...state,
			diffText: `${state.diffText}\n 9|const s = "\x1b[31m";`,
			sanitizedDiffText: `${state.sanitizedDiffText}\n 9|const s = "\x1b[31m";`,
		}),
	],
	aSecondRenderReturnsTheSameBytes: [
		state => ({ ...state, rowsFromASecondRender: [...state.rows.slice(0, -1), "  9│different"] }),
		state => ({ ...state, rowsFromASecondRender: state.rows.slice(0, -1) }),
		state => ({ ...state, rowsFromASecondRender: [...state.rows, "  9│one more"] }),
	],
	aStreamedPrefixRendersByteIdentically: [
		state => ({
			...state,
			prefixRenders: state.prefixRenders.map((prefix, index) =>
				index === 0 ? ["  1│a row the finished render never had"] : prefix,
			),
		}),
		state => ({
			...state,
			prefixRenders: state.prefixRenders.map((prefix, index) => (index === 1 ? prefix.slice(0, 1) : prefix)),
		}),
		state => ({
			...state,
			prefixRenders: state.prefixRenders.map((prefix, index) =>
				index === 0 ? [...prefix, "  2│arrived early"] : prefix,
			),
		}),
	],
};

/** A guarantee out of scope on a state reports `skipped`, and the suite has to see that happen. */
const STAND_DOWNS: readonly { id: DiffRenderOracleGuarantee; spec: DiffRenderCase; why: string }[] = [
	{
		id: "aStreamedPrefixRendersByteIdentically",
		spec: { fixture: "crossingThousand", filePath: 1 },
		why: "a line number past 999 does not fit the gutter the renderer reserves",
	},
	{
		id: "noContentSuppliedEscapeSurvivesIntoARow",
		spec: { fixture: "spaceIndent", filePath: 1 },
		why: "the diff content carries no escape byte for the sanitizer to strip",
	},
];

describe("every diff render oracle can fail on a render that earns it", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("judges the baseline render clean", () => {
		const evaluation = evaluateAllDiffRenderOracles(diffStateFor(BASELINE));
		expect(evaluation.failures).toEqual([]);
		expect(evaluation.blind).toEqual([]);
	});

	it.each(
		DIFF_RENDER_ORACLE_GUARANTEES.flatMap(id =>
			DEFECTS[id].map((craft, index) => [`${id} craft ${index}`, id, craft] as const),
		),
	)("%s reports the defect it owns and nothing else", (_label, id, craft) => {
		const clean = diffStateFor(BASELINE);
		const broken = craft(clean);

		// A craft that changed nothing would pass as a clean baseline, which is the failure mode this
		// suite exists to rule out. `widthOf` is a function and is not part of the comparison.
		const shape = (state: DiffRenderOracleFrameState): string =>
			JSON.stringify([
				state.rows,
				state.rowsFromASecondRender,
				state.prefixRenders,
				state.inputRows,
				state.sanitizedDiffText,
			]);
		expect(shape(broken)).not.toBe(shape(clean));

		const before = evaluateAllDiffRenderOracles(clean);
		expect(before.failures.map(failure => failure.oracle)).not.toContain(id);

		const after = evaluateAllDiffRenderOracles(broken);
		expect(after.failures.map(failure => failure.oracle)).toEqual([id]);
		expect(after.failures[0]?.message.length ?? 0).toBeGreaterThan(0);
	});

	it.each(STAND_DOWNS.map(entry => [`${entry.id} stands down when ${entry.why}`, entry] as const))(
		"%s",
		(_label, entry) => {
			const state = diffStateFor(entry.spec);
			expect(DIFF_RENDER_ORACLES[entry.id].appliesTo(state)).toBe(false);
			expect(evaluateAllDiffRenderOracles(state).skipped).toContain(entry.id);
		},
	);

	it("declares a guarantee for every id and an id for every guarantee", () => {
		expect(Object.keys(DIFF_RENDER_ORACLES).sort()).toEqual([...DIFF_RENDER_ORACLE_GUARANTEES].sort());
		for (const id of DIFF_RENDER_ORACLE_GUARANTEES) {
			expect(DIFF_RENDER_ORACLES[id].guarantee.length).toBeGreaterThan(40);
		}
	});

	it("crafts a defect for every guarantee, so a new guarantee arrives unproven and red", () => {
		expect(Object.keys(DEFECTS).sort()).toEqual([...DIFF_RENDER_ORACLE_GUARANTEES].sort());
		for (const id of DIFF_RENDER_ORACLE_GUARANTEES) {
			expect(DEFECTS[id].length).toBeGreaterThan(0);
		}
	});
});
