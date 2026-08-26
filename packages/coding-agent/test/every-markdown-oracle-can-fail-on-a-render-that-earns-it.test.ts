/**
 * WHY THIS SUITE EXISTS:
 * The markdown registry is nine guarantees over the component that produces most of the rows in a
 * session. A guarantee that cannot fail is worse than no guarantee: the sweep beside it reports clean
 * and the surface reads as covered. Four of the nine compare one render against another (a second
 * instance, a resize, the next width, a frozen prefix), and a comparison is the easiest kind of check
 * to write so it can never disagree.
 *
 * WHAT IT ASSERTS:
 * For each of the nine ids, a state that earns exactly that failure produces exactly it, and the clean
 * state it was derived from produces nothing. The defect is crafted on the state, not on the source
 * text, because a source that provokes a real defect would be a defect the sweep should be reporting;
 * what is under test here is the check.
 *
 * A crafted state changes one thing from a real render, and the derivation is asserted to have changed
 * something, so a craft that silently became a no-op fails rather than passing as a clean baseline.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Whether a guarantee is the right guarantee. It proves each check disagrees with a state that
 * violates it; whether the component can reach that state is what the sweep is for. It also does not
 * prove a check is minimal: a check that also fires on states it should ignore is caught by the
 * `appliesTo` assertions here and by the clean sweep, not by this suite alone.
 *
 * MUTATION GATE, run and recorded:
 * - `widthOf` in the runner replaced by `text.length`: 3 fail.
 * - the table scope dropped from `aWiderTerminalNeverNeedsMoreRows`: sweep 1 fail.
 * - `firstDifference` returning -1 unconditionally: 3 fail here.
 * - `painted()` returning its rows unfiltered: 1 fail here.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	evaluateAllMarkdownOracles,
	MARKDOWN_ORACLE_GUARANTEES,
	MARKDOWN_ORACLES,
	type MarkdownOracleFrameState,
	type MarkdownOracleGuarantee,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import { type MarkdownCase, markdownStateFor } from "./helpers/defect-oracles";

/**
 * The states every craft below is derived from, both really produced by the component.
 *
 * `fence` carries a blank line, which is what the streaming path needs: a source without one has
 * no blank-line-bounded prefix to freeze, so the prefix guarantee stands down on it.
 */
const PADDED: MarkdownCase = { fixture: "fence", width: 40, paddingX: 2 };
const UNPADDED: MarkdownCase = { fixture: "fence", width: 40, paddingX: 0 };

type Craft = (state: MarkdownOracleFrameState) => MarkdownOracleFrameState;

/**
 * Replace the rows a state was built from, and move every comparison arm with them.
 *
 * A craft that changed `rows` alone would earn four failures rather than one: the second instance, the
 * resize and the prefix would all disagree with the corrupted rows, and the width comparison would see
 * a row count out of nowhere. Corrupting a row is the defect being modelled; disagreeing with itself
 * is not, so the arms move together and the prefix is dropped.
 */
function withRows(state: MarkdownOracleFrameState, rows: readonly string[]): MarkdownOracleFrameState {
	return {
		...state,
		rows,
		rowsFromASecondInstance: rows,
		rowsAfterAResize: rows,
		rowsAtTheNextWidth: state.rowsAtTheNextWidth === null ? null : rows.slice(0, 1),
		prefix: null,
	};
}

/**
 * One or more crafts per guarantee. Each changes the smallest thing that earns that failure and
 * nothing else, so a craft that trips a second oracle is a craft that is wrong about which defect it
 * models.
 *
 * A comparison guarantee gets two: one where the rows differ in content and one where they differ only
 * in count. The two take different paths through `firstDifference` (the loop, and the length test after
 * it), and a mutation gate proved that a suite carrying only the content craft stays green when the
 * length test is replaced by an unconditional agreement. A prefix that stops short and a prefix that
 * runs long are the two ways the streaming cache is wrong in production, so both are named.
 */
const DEFECTS: Readonly<Record<MarkdownOracleGuarantee, { from: MarkdownCase; crafts: readonly Craft[] }>> = {
	everyRowFitsTheWidth: {
		from: UNPADDED,
		crafts: [state => withRows(state, [state.rows[0] ?? "ok", "x".repeat(state.width + 1)])],
	},
	noRowCarriesALineBreak: {
		from: UNPADDED,
		crafts: [state => withRows(state, ["ok", "two\nrows"])],
	},
	noRowForwardsARawTab: {
		from: UNPADDED,
		crafts: [state => withRows(state, ["ok", "a\tb"])],
	},
	noRowSeversAnEscapeSequence: {
		from: UNPADDED,
		crafts: [state => withRows(state, ["ok", "text \x1b[1;3"])],
	},
	theLeftPaddingIsOnEveryPaintedRow: {
		from: PADDED,
		crafts: [state => withRows(state, [state.rows[0] ?? "  ok", "unindented"])],
	},
	aSecondInstanceRendersTheSameRows: {
		from: UNPADDED,
		crafts: [
			state => ({ ...state, rowsFromASecondInstance: [...state.rows.slice(0, -1), "different"] }),
			state => ({ ...state, rowsFromASecondInstance: state.rows.slice(0, -1) }),
			state => ({ ...state, rowsFromASecondInstance: [...state.rows, "one more"] }),
		],
	},
	aResizedInstanceReturnsToItsFirstRows: {
		from: UNPADDED,
		crafts: [
			state => ({ ...state, rowsAfterAResize: [...state.rows.slice(0, -1), "different"] }),
			state => ({ ...state, rowsAfterAResize: state.rows.slice(0, -1) }),
			state => ({ ...state, rowsAfterAResize: [...state.rows, "one more"] }),
		],
	},
	aWiderTerminalNeverNeedsMoreRows: {
		from: UNPADDED,
		crafts: [state => ({ ...state, rowsAtTheNextWidth: [...state.rows, "one more row"] })],
	},
	aFrozenPrefixRendersAsAPrefix: {
		from: UNPADDED,
		crafts: [
			state => ({
				...state,
				prefix: { text: state.prefix?.text ?? state.source, rows: ["not what the full render starts with"] },
			}),
			// A prefix that runs past the full render: every row it shares agrees, and there is one more.
			state => ({
				...state,
				prefix: {
					text: state.prefix?.text ?? state.source,
					rows: [...state.rows, "a row the full render never had"],
				},
			}),
		],
	},
};

/** A guarantee out of scope on a state reports `skipped`, and the sweep has to see that happen. */
const STAND_DOWNS: readonly { id: MarkdownOracleGuarantee; spec: MarkdownCase; why: string }[] = [
	{
		id: "theLeftPaddingIsOnEveryPaintedRow",
		spec: UNPADDED,
		why: "there is no padding to be on a row",
	},
	{
		id: "aWiderTerminalNeverNeedsMoreRows",
		spec: { fixture: "wideTable", width: 40, paddingX: 0 },
		why: "a table reflows into more rows as the width grows",
	},
	{
		id: "aWiderTerminalNeverNeedsMoreRows",
		spec: { fixture: "fence", width: 200, paddingX: 0 },
		why: "the widest width in the sweep has no wider width to compare against",
	},
	{
		id: "aFrozenPrefixRendersAsAPrefix",
		spec: { fixture: "paragraph", width: 40, paddingX: 0 },
		why: "a source with no blank line has no blank-line-bounded prefix to freeze",
	},
	{
		id: "everyRowFitsTheWidth",
		spec: { fixture: "fence", width: 1, paddingX: 2 },
		why: "four columns of padding do not fit in one column of terminal",
	},
];

describe("every markdown oracle can fail on a render that earns it", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it.each([PADDED, UNPADDED].map(spec => [`${spec.fixture} at ${spec.width}/${spec.paddingX}`, spec] as const))(
		"judges the %s baseline clean",
		(_label, spec) => {
			const evaluation = evaluateAllMarkdownOracles(markdownStateFor(spec));
			expect(evaluation.failures).toEqual([]);
			// Every guarantee that applies reads something. A blind one on a baseline would mean a craft
			// below is proving a check that never runs on a real render.
			expect(evaluation.blind).toEqual([]);
		},
	);

	it.each(
		MARKDOWN_ORACLE_GUARANTEES.flatMap(id =>
			DEFECTS[id].crafts.map((craft, index) => [`${id} craft ${index}`, id, craft] as const),
		),
	)("%s reports the defect it owns and nothing else", (_label, id, craft) => {
		const clean = markdownStateFor(DEFECTS[id].from);
		const broken = craft(clean);

		// A craft that changed nothing would pass as a clean baseline, which is the failure mode this
		// suite exists to rule out. `widthOf` is a function and is not part of the comparison.
		const shape = (state: MarkdownOracleFrameState): string =>
			JSON.stringify([
				state.rows,
				state.rowsFromASecondInstance,
				state.rowsAfterAResize,
				state.rowsAtTheNextWidth,
				state.prefix,
			]);
		expect(shape(broken)).not.toBe(shape(clean));

		const before = evaluateAllMarkdownOracles(clean);
		expect(before.failures.map(failure => failure.oracle)).not.toContain(id);

		const after = evaluateAllMarkdownOracles(broken);
		expect(after.failures.map(failure => failure.oracle)).toEqual([id]);
		expect(after.failures[0]?.message.length ?? 0).toBeGreaterThan(0);
	});

	it.each(STAND_DOWNS.map(entry => [`${entry.id} stands down when ${entry.why}`, entry] as const))(
		"%s",
		(_label, entry) => {
			const state = markdownStateFor(entry.spec);
			expect(MARKDOWN_ORACLES[entry.id].appliesTo(state)).toBe(false);
			expect(evaluateAllMarkdownOracles(state).skipped).toContain(entry.id);
		},
	);

	it("declares a guarantee for every id and an id for every guarantee", () => {
		expect(Object.keys(MARKDOWN_ORACLES).sort()).toEqual([...MARKDOWN_ORACLE_GUARANTEES].sort());
		for (const id of MARKDOWN_ORACLE_GUARANTEES) {
			expect(MARKDOWN_ORACLES[id].guarantee.length).toBeGreaterThan(40);
		}
	});

	it("crafts one defect per guarantee, so a new guarantee arrives unproven and red", () => {
		expect(Object.keys(DEFECTS).sort()).toEqual([...MARKDOWN_ORACLE_GUARANTEES].sort());
	});
});
