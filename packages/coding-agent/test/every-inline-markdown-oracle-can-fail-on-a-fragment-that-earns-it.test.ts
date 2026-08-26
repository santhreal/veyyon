/**
 * WHY THIS SUITE EXISTS:
 * Ten guarantees over the inline markdown renderer, and nine of the ten ledgers in the sweep beside
 * this file are pinned non-empty. A pinned ledger is a stronger claim than an empty one, not a weaker
 * one: it says the check fails on exactly these inputs and on nothing else. That is worthless if the
 * check cannot fail for a reason other than the one input it was written against, and three of the ten
 * compare one render against another, which is the easiest kind of check to write so it can never
 * disagree.
 *
 * WHAT IT ASSERTS:
 * For each of the ten ids, a state that earns exactly that failure produces exactly it, and the clean
 * state it was derived from produces nothing. The defect is crafted on the state rather than on the
 * source, because a source that provokes a real defect is a defect the sweep should be reporting; what
 * is under test here is the check.
 *
 * A comparison guarantee gets three crafts: a fragment that differs in content, one that is a prefix,
 * and one that is longer. The first walks the character scan and the other two walk the length
 * difference, and a suite carrying only the first goes green when the scan is replaced by an
 * unconditional agreement. That mutation was run against the markdown registry, which had the same
 * shape and the same hole.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Whether a guarantee is the right guarantee for the renderer. It proves each check disagrees with a
 * state that violates it; whether the renderer can reach that state is what the sweep is for.
 *
 * MUTATION GATE, run and recorded across this file and the sweep beside it:
 * - `plainFragment` returning its argument unchanged: 6 fail.
 * - an SGR closer no longer closing in `openAfter`: 20 fail.
 * - the escape surplus computed as a set difference rather than a multiset one: 1 fail. That mutation
 *   was green on the first run, because no source supplied a sequence the theme also emits. The
 *   `contentSgrMimic` source, which carries the exact bytes the base colour closes with, closed it.
 * - `firstUnstyledCell` never reporting an unstyled cell: 2 fail.
 * - the C0 owner split emptied, so the tab and line bytes are reported twice: 3 fail.
 * - the renderer itself stripping the newline it forwards: 1 fail, which is the pinned ledger row
 *   going red when the defect it records is fixed.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	evaluateAllInlineMarkdownOracles,
	INLINE_MARKDOWN_ORACLE_GUARANTEES,
	INLINE_MARKDOWN_ORACLES,
	type InlineMarkdownOracleFrameState,
	type InlineMarkdownOracleGuarantee,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import { type InlineMarkdownCase, inlineMarkdownStateFor } from "./helpers/defect-oracles";

/**
 * The state every craft is derived from: a real render of a label carrying bold, italic and plain runs,
 * through the coloured caller shape nine of the twelve call sites use.
 *
 * `nested` rather than a source with a code span or a table, because both of those carry live defects
 * and a baseline has to be clean for a craft to be the only reason a guarantee fails.
 */
const BASELINE: InlineMarkdownCase = { fixture: "nested", shape: "based" };

type Craft = (state: InlineMarkdownOracleFrameState) => InlineMarkdownOracleFrameState;

/**
 * Replace the fragment, and move every comparison arm with it.
 *
 * A craft that changed `fragment` alone would earn several failures rather than one: the second render
 * and the escape-free control would disagree with the corrupted fragment, and the word check would
 * report the synthetic fragment as having lost the source's content. Corrupting a fragment is the
 * defect being modelled; disagreeing with itself is not, so the source becomes one that claims no words
 * and the arms follow the fragment.
 */
function withFragment(state: InlineMarkdownOracleFrameState, fragment: string): InlineMarkdownOracleFrameState {
	return {
		...state,
		source: "",
		fragment,
		fragmentFromASecondRender: fragment,
		fragmentWithNoBaseColour: fragment,
		fragmentFromSourceWithNoEscapes: fragment,
	};
}

const STYLED = "\x1b[38;5;250m";
const CLOSED = "\x1b[39m";

/** A styled fragment of plain cells, which is what the baseline shape produces. */
function styled(cells: string): string {
	return `${STYLED}${cells}${CLOSED}`;
}

const DEFECTS: Readonly<Record<InlineMarkdownOracleGuarantee, readonly Craft[]>> = {
	theRenderedFragmentIsASingleLine: [state => withFragment(state, styled("head\ntail"))],
	theRenderedFragmentForwardsNoRawTab: [state => withFragment(state, styled("head\ttail"))],
	theRenderedFragmentCarriesNoC0Control: [
		// A BEL, and a fragment carrying no OSC so the sever guarantee does not own the byte.
		state => withFragment(state, styled("head\x07tail")),
		// A backspace, which moves left over a cell the caller already painted.
		state => withFragment(state, styled("head\btail")),
	],
	everyEscapeInTheFragmentIsComplete: [
		// An ESC that begins no sequence at all. It sits inside the style span and is followed by another
		// ESC, because an ESC followed by a printable byte is a complete two-byte escape and would be
		// read as a sequence rather than as a severed one.
		state => withFragment(state, `${STYLED}head\x1b${CLOSED}`),
		// A CSI whose final byte never arrives, which is the shape a truncation produces.
		state => withFragment(state, `${STYLED}head\x1b[38;5${CLOSED}`),
	],
	noContentSuppliedEscapeSurvivesIntoTheFragment: [
		// The source carries an escape and the fragment carries a sequence the escape-free control does
		// not produce, which is what a surviving content escape looks like.
		state => ({
			// The surviving sequence closes itself, so the fragment does not also leave a style open and
			// earn the closing guarantee's failure alongside this one.
			...withFragment(state, `${STYLED}head\x1b[31mtail\x1b[39m${CLOSED}`),
			source: "head \x1b[31m tail",
			fragmentFromSourceWithNoEscapes: styled("head tail"),
		}),
	],
	theFragmentClosesEveryStyleItOpens: [
		// One attribute opened and never closed, which is the state the caller's next cell paints in.
		state => withFragment(state, `${STYLED}head`),
	],
	everyPaintedCellSitsInsideAStyle: [
		// A cell painted after the style closed, which reads in whatever the row above left behind.
		state => withFragment(state, `${styled("head")}tail`),
	],
	noWordOfTheSourceIsDroppedFromTheFragment: [
		// The source says a word the fragment does not paint, and it is not markup a construct consumes.
		state => ({ ...withFragment(state, styled("head")), source: "head vanished" }),
	],
	aSecondRenderReturnsTheSameFragment: [
		// Content differs at a shared index, which walks the character scan.
		state => ({ ...withFragment(state, styled("head")), fragmentFromASecondRender: styled("heaD") }),
		// One character short, which walks the length difference.
		state => ({ ...withFragment(state, styled("head")), fragmentFromASecondRender: styled("hea") }),
		// One character long, which walks the same difference from the other side.
		state => ({ ...withFragment(state, styled("head")), fragmentFromASecondRender: styled("heads") }),
	],
	strippingTheStylesLeavesWhatAnUnstyledRenderPaints: [
		// The painted cells differ at a shared index.
		state => ({ ...withFragment(state, styled("head")), fragmentWithNoBaseColour: "heaD" }),
		// The bare render paints one cell fewer.
		state => ({ ...withFragment(state, styled("head")), fragmentWithNoBaseColour: "hea" }),
		// The bare render paints one cell more.
		state => ({ ...withFragment(state, styled("head")), fragmentWithNoBaseColour: "heads" }),
	],
};

/**
 * The states a guarantee declares out of scope, with the reason read off the state.
 *
 * A guarantee that applies to everything is a guarantee whose scope nobody has thought about; a scope
 * asserted here is one somebody stated and can be shown.
 */
const STAND_DOWNS: readonly { id: InlineMarkdownOracleGuarantee; spec: InlineMarkdownCase; why: string }[] = [
	{
		id: "noContentSuppliedEscapeSurvivesIntoTheFragment",
		spec: { fixture: "plain", shape: "based" },
		why: "the source carries no escape byte for the renderer to forward",
	},
	{
		id: "everyPaintedCellSitsInsideAStyle",
		spec: { fixture: "plain", shape: "bare" },
		why: "the caller supplied no base colour, so an unstyled cell is what it asked for",
	},
	{
		id: "strippingTheStylesLeavesWhatAnUnstyledRenderPaints",
		spec: { fixture: "plain", shape: "bare" },
		why: "there is no base colour to strip",
	},
	{
		id: "everyEscapeInTheFragmentIsComplete",
		spec: { fixture: "plain", shape: "bare" },
		why: "the fragment carries no escape byte at all",
	},
	{
		id: "noWordOfTheSourceIsDroppedFromTheFragment",
		spec: { fixture: "blank", shape: "based" },
		why: "the source says no word that could be dropped",
	},
];

describe("every inline markdown oracle can fail on a fragment that earns it", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("judges the baseline fragment clean", () => {
		const evaluation = evaluateAllInlineMarkdownOracles(inlineMarkdownStateFor(BASELINE));
		expect(evaluation.failures).toEqual([]);
		expect(evaluation.blind).toEqual([]);
	});

	it.each(
		INLINE_MARKDOWN_ORACLE_GUARANTEES.flatMap(id =>
			DEFECTS[id].map((craft, index) => [`${id} craft ${index}`, id, craft] as const),
		),
	)("%s reports the defect it owns and nothing else", (_label, id, craft) => {
		const clean = inlineMarkdownStateFor(BASELINE);
		const broken = craft(clean);

		// A craft that changed nothing would pass as a clean baseline, which is the failure mode this
		// suite exists to rule out. `widthOf` is a function and is not part of the comparison.
		const shape = (state: InlineMarkdownOracleFrameState): string =>
			JSON.stringify([
				state.source,
				state.fragment,
				state.fragmentFromASecondRender,
				state.fragmentWithNoBaseColour,
				state.fragmentFromSourceWithNoEscapes,
			]);
		expect(shape(broken)).not.toBe(shape(clean));

		const before = evaluateAllInlineMarkdownOracles(clean);
		expect(before.failures.map(failure => failure.oracle)).not.toContain(id);

		const after = evaluateAllInlineMarkdownOracles(broken);
		expect(after.failures.map(failure => failure.oracle)).toEqual([id]);
		expect(after.failures[0]?.message.length ?? 0).toBeGreaterThan(0);
	});

	it.each(STAND_DOWNS.map(entry => [`${entry.id} stands down when ${entry.why}`, entry] as const))(
		"%s",
		(_label, entry) => {
			const state = inlineMarkdownStateFor(entry.spec);
			expect(INLINE_MARKDOWN_ORACLES[entry.id].appliesTo(state)).toBe(false);
			expect(evaluateAllInlineMarkdownOracles(state).skipped).toContain(entry.id);
		},
	);

	it("declares a guarantee for every id and an id for every guarantee", () => {
		expect(Object.keys(INLINE_MARKDOWN_ORACLES).sort()).toEqual([...INLINE_MARKDOWN_ORACLE_GUARANTEES].sort());
		for (const id of INLINE_MARKDOWN_ORACLE_GUARANTEES) {
			expect(INLINE_MARKDOWN_ORACLES[id].guarantee.length).toBeGreaterThan(40);
		}
	});

	it("crafts a defect for every guarantee, so a new guarantee arrives unproven and red", () => {
		expect(Object.keys(DEFECTS).sort()).toEqual([...INLINE_MARKDOWN_ORACLE_GUARANTEES].sort());
		for (const id of INLINE_MARKDOWN_ORACLE_GUARANTEES) {
			expect(DEFECTS[id].length).toBeGreaterThan(0);
		}
	});

	it("gives every comparison guarantee a craft for each path through its difference walk", () => {
		// The mutation that found this hole in the markdown registry: a comparison whose crafts all
		// differ in content stays green when the length test is replaced by an unconditional agreement.
		const comparisons: readonly InlineMarkdownOracleGuarantee[] = [
			"aSecondRenderReturnsTheSameFragment",
			"strippingTheStylesLeavesWhatAnUnstyledRenderPaints",
		];
		for (const id of comparisons) {
			expect(DEFECTS[id].length, `${id} needs a craft per path`).toBeGreaterThanOrEqual(3);
		}
	});
});
