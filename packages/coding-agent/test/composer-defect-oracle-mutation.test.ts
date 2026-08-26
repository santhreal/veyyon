/**
 * Every composer defect oracle can fail, and fails through the evaluator rather than only when
 * called by hand.
 *
 * WHY THIS SUITE EXISTS:
 * An oracle that cannot fail is worthless, and a sweep of thousands of states built on one is
 * theatre. Each guarantee therefore has at least one crafted frame that is wrong in the way that
 * guarantee describes, and the defect has to come back out of `evaluateAllComposerOracles`.
 *
 * Going through the evaluator is the point. Calling `checkX` directly proves the predicate works and
 * says nothing about whether the registry lets it run: an `appliesTo` that rejects the very state its
 * own defect lives in suppresses the failure and reports the state as out of scope, which reads as a
 * pass. That is the same shape as the two oracles that were found inspecting nothing. The cases are
 * filed in a `Record` keyed by the guarantee union, so a thirteenth oracle without a crafted defect
 * does not compile.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether an oracle fires on a defect a real mount can produce. These frames are synthetic; the
 *   sweep and the differential drive real mounts, and the product mutation gates recorded in those
 *   suites are what prove the oracles catch a renderer defect rather than a hand-built one.
 * - Over-triggering. A crafted frame may fail several guarantees, and only the one under test is
 *   asserted. The sweep is what proves a correct frame fails nothing.
 * - A guarantee with exactly one crafted defect is proven able to fail, not proven to cover its whole
 *   statement.
 *
 * MUTATION GATE:
 * Setting any entry's `appliesTo` to `() => false` in the registry turns that guarantee's cases red
 * with the diagnosis naming it as skipped, which the direct-call version of this suite could not see.
 */

import { describe, expect, it } from "bun:test";
import {
	COMPOSER_ORACLE_GUARANTEES,
	type ComposerOracleFrameState,
	type ComposerOracleGuarantee,
	checkComposerCardPadsAreUnpaintedAir,
	evaluateAllComposerOracles,
} from "../src/modes/components/composer-defect-oracle";

function createBaselineFrameState(): ComposerOracleFrameState {
	const width = 80;
	const height = 10;
	const transcriptLines = [
		"transcript row 0",
		"transcript row 1",
		"transcript row 2",
		"transcript row 3",
		"transcript row 4",
	];
	const footerLines = [
		"────────────────────────────────────────────────────────────────────────────────",
		"",
		"  › hello world",
		"",
		"location: ~/project · model: test-model",
	];
	const viewportLines = [...transcriptLines, ...footerLines];
	const rawViewportLines = [...viewportLines];

	return {
		width,
		height,
		viewportLines,
		rawViewportLines,
		cursor: { row: 7, col: 15 },
		totalFrameRows: 10,
		windowTopRow: 0,
		pinnedFooterChildCount: 5,
		pinnedFooterRows: 5,
		editorFocused: true,
		virtualScrollTop: null,
		transcriptLineMarkers: ["transcript row", "transcript-output-line"],
		screenBounds: {
			footerTop: 5,
			footerBottom: 9,
			footerRowOffset: 5,
			contentBottom: 9,
		},
		segments: [
			{ startIndex: 0, rowCount: 5, componentName: "TranscriptMock" },
			{ startIndex: 5, rowCount: 1, componentName: "ComposerHairline" },
			{ startIndex: 6, rowCount: 1, componentName: "CardPadRow" },
			{ startIndex: 7, rowCount: 1, componentName: "Editor" },
			{ startIndex: 8, rowCount: 1, componentName: "CardPadRow" },
			{ startIndex: 9, rowCount: 1, componentName: "QuietZoneLine" },
		],
		mouseRouting: new Map([
			[5, { routedTo: "footer:hairline", localLine: 0, col: 0 }],
			[6, { routedTo: "footer:pad", localLine: 0, col: 0 }],
			[7, { routedTo: "footer:editor", localLine: 0, col: 0 }],
			[8, { routedTo: "footer:pad", localLine: 0, col: 0 }],
			[9, { routedTo: "footer:quietZone", localLine: 0, col: 0 }],
		]),
		liveFooterLines: [...footerLines],
	};
}

/** Replace one screen row, in both the stripped and the raw grid. */
function withRow(state: ComposerOracleFrameState, row: number, line: string): ComposerOracleFrameState {
	const viewportLines = [...state.viewportLines];
	viewportLines[row] = line;
	const rawViewportLines = [...state.rawViewportLines];
	rawViewportLines[row] = line;
	return { ...state, viewportLines, rawViewportLines };
}

/** Paint a background into the pad row while leaving it blank once the escapes are stripped. */
function withPadFill(state: ComposerOracleFrameState, fill: string): ComposerOracleFrameState {
	const rawViewportLines = [...state.rawViewportLines];
	rawViewportLines[6] = `${fill}   \x1b[0m`;
	const viewportLines = [...state.viewportLines];
	viewportLines[6] = "";
	return { ...state, rawViewportLines, viewportLines };
}

/** One frame that is wrong in the way its guarantee describes. */
interface DefectCase {
	/** What is wrong with the frame. */
	name: string;
	/** A phrase the failure has to say, so a rewording is a decision rather than a silent drift. */
	says: string;
	break(base: ComposerOracleFrameState): ComposerOracleFrameState;
}

/**
 * A crafted defect per guarantee.
 *
 * Keyed by the guarantee union: a new oracle with no way to fail does not compile.
 */
const DEFECTS: Readonly<Record<ComposerOracleGuarantee, readonly DefectCase[]>> = {
	exactlyOneComposerPrompt: [
		{
			name: "a second prompt row is painted in the transcript region",
			says: "Expected 1 composer prompt row(s)",
			break: base => withRow(base, 2, "  › duplicate prompt row"),
		},
		{
			name: "the composer's own prompt row is painted without its glyph",
			says: "Expected 1 composer prompt row(s)",
			break: base => withRow(base, 7, "  just plain text without prompt"),
		},
	],
	noOutputBleedPastComposer: [
		{
			name: "a transcript row is painted inside the footer zone",
			says: "inside the composer footer zone",
			break: base => withRow(base, 7, "transcript-output-line-0099 bleed past composer"),
		},
	],
	noMixedTranscriptAndChromeRows: [
		{
			name: "one row carries both the prompt glyph and transcript content",
			says: "mixes transcript content with composer chrome",
			break: base => withRow(base, 7, "  › transcript-output-line-0012 hello"),
		},
	],
	footerOccupiesBottomPhysicalRows: [
		{
			name: "the footer stops one row short of the terminal bottom",
			says: "does not reach terminal bottom",
			break: base => ({ ...base, screenBounds: { ...base.screenBounds, footerBottom: 8 } }),
		},
	],
	noFooterRowsAboveFooterRegion: [
		{
			name: "composer chrome is painted above the footer region",
			says: "Composer prompt row found at row 2",
			break: base => withRow(base, 2, "  › leaked prompt in transcript"),
		},
	],
	mouseClickRoutesToRenderedZone: [
		{
			name: "a click on a footer row is dispatched to the transcript",
			says: "is inside footer bounds [5..9] but routed to transcript",
			break: base => {
				const mouseRouting = new Map(base.mouseRouting ?? []);
				mouseRouting.set(7, { routedTo: "transcript", localLine: null, col: null });
				return { ...base, mouseRouting };
			},
		},
	],
	caretWithinComposerEditorBounds: [
		{
			name: "the caret sits past the right edge of the terminal",
			says: "outside terminal width",
			break: base => ({ ...base, cursor: { row: 7, col: 85 } }),
		},
		{
			name: "the caret sits in the transcript region",
			says: "outside footer screen row bounds",
			break: base => ({ ...base, cursor: { row: 2, col: 5 } }),
		},
	],
	noHorizontalOverflow: [
		{
			name: "a row is painted wider than the terminal",
			says: "exceeding terminal width 80",
			break: base => withRow(base, 3, "x".repeat(95)),
		},
	],
	composerCardPadsAreUnpaintedAir: [
		{
			name: "a breathing row above the input carries text",
			says: "has non-blank content or background styling",
			break: base => withRow(base, 6, "leaked text in padding"),
		},
		{
			name: "a breathing row is blank but painted with a truecolor background",
			says: "has non-blank content or background styling",
			break: base => withPadFill(base, "\x1b[48;2;255;0;0m"),
		},
	],
	composerHairlineSpanAndPlacement: [
		{
			name: "the hairline claims two rows",
			says: "ComposerHairline segment rowCount is 2, expected exactly 1",
			break: base => ({
				...base,
				segments: base.segments.map(s => (s.componentName === "ComposerHairline" ? { ...s, rowCount: 2 } : s)),
			}),
		},
	],
	footerHeightMatchesComposedSegmentLedger: [
		{
			name: "the pinned footer height disagrees with its children's rows",
			says: "does not match segment ledger sum",
			break: base => ({ ...base, pinnedFooterRows: 7 }),
		},
	],
	virtualScrollPreservesFooterStability: [
		{
			name: "a frozen view paints a footer row the live footer does not have",
			says: "differs from live footer",
			break: base => ({
				...withRow(base, 7, "  › corrupted virtual scroll footer row"),
				virtualScrollTop: 2,
			}),
		},
	],
};

describe("the baseline frame is the control", () => {
	it("fails nothing, reads a subject for every guarantee in scope, and goes blind nowhere", () => {
		const result = evaluateAllComposerOracles(createBaselineFrameState());
		expect(result.failures).toEqual([]);
		expect(result.blind).toEqual([]);
		// The baseline is a live-tail frame, so the frozen-view guarantee is the one guarantee out of
		// scope. Pinned by exact equality: a predicate that quietly stops applying to a plain frame is
		// how a guarantee stops being enforced.
		expect([...result.skipped].sort()).toEqual(["virtualScrollPreservesFooterStability"]);
	});
});

describe("every guarantee has a defect that makes it fail", () => {
	it("files at least one crafted defect for every guarantee", () => {
		const missing = COMPOSER_ORACLE_GUARANTEES.filter(id => DEFECTS[id].length === 0);
		expect([...missing].sort()).toEqual([]);
	});

	for (const id of COMPOSER_ORACLE_GUARANTEES) {
		for (const defect of DEFECTS[id]) {
			it(`${id}: ${defect.name}`, () => {
				const result = evaluateAllComposerOracles(defect.break(createBaselineFrameState()));
				const failure = result.failures.find(f => f.oracle === id);
				expect(
					failure,
					`${id} reported no failure on its own defect. skipped=[${result.skipped.join(", ")}] blind=[${result.blind.join(", ")}]`,
				).toBeDefined();
				if (!failure) return;
				expect(failure.message).toContain(defect.says);
				// The evaluator has to have let it run, not merely not contradicted it.
				expect(result.inspected).toContain(id);
			});
		}
	}
});

describe("a pad row's background is read from the SGR parameters, not the shape of the escape", () => {
	// This one calls the predicate directly on purpose: the negative half asserts the absence of a
	// failure, and going through the evaluator would not distinguish a predicate that found nothing
	// from one the registry never ran.
	it("treats a background fill as paint in every spelling", () => {
		const base = createBaselineFrameState();
		for (const fill of ["\x1b[41m", "\x1b[101m", "\x1b[48;2;255;0;0m", "\x1b[48:2:255:0:0m"]) {
			expect(checkComposerCardPadsAreUnpaintedAir(withPadFill(base, fill))?.oracle, fill).toBe(
				"composerCardPadsAreUnpaintedAir",
			);
		}
	});

	it("treats underline, a background reset and an extended foreground as unpainted", () => {
		const base = createBaselineFrameState();
		// Underline and background-reset both begin with `4`, and an extended foreground carries a
		// subparameter that reads as background 41 unless the parameter list is walked.
		for (const bare of ["\x1b[4m", "\x1b[49m", "\x1b[38;5;41m", "\x1b[38;2;0;41;0m"]) {
			expect(checkComposerCardPadsAreUnpaintedAir(withPadFill(base, bare)), bare).toBeNull();
		}
	});
});
