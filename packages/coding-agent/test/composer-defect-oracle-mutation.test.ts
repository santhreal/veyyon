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
 * - A check's branches are not enumerable at run time, so no claim here proves every branch of every
 *   check has a craft. What is enforced is that no guarantee gets away with a single one: the set of
 *   single-craft guarantees is pinned empty, so a new oracle with one defect has to be argued for.
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
} from "../src/modes/components/defect-oracles";

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
		// A control frame carries no style, so nothing bleeds. The style-bleed defects below add
		// columns to one row rather than starting from a coloured frame, which keeps every other
		// guarantee's baseline untouched.
		styledColumns: viewportLines.map(() => ({ background: [], foreground: [], underline: [] })),
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

/** Give one row a run of styled columns, as the cell grid reports them. */
function withStyle(
	state: ComposerOracleFrameState,
	row: number,
	attribute: "background" | "foreground" | "underline",
	columns: readonly number[],
): ComposerOracleFrameState {
	const styledColumns = state.styledColumns.map((entry, index) =>
		index === row ? { ...entry, [attribute]: [...columns] } : entry,
	);
	return { ...state, styledColumns };
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
		{
			// A frozen view shows the footer's tail. A footer whose prompt sits above that tail must
			// paint no prompt row at all, so a painted one is a leak from the live composer.
			name: "a frozen view paints a prompt the visible footer tail does not contain",
			says: "Expected 0 composer prompt row(s)",
			break: base => ({
				...base,
				virtualScrollTop: 2,
				liveFooterLines: [
					"  › hello world",
					"filler 1",
					"filler 2",
					"filler 3",
					"filler 4",
					"filler 5",
					"filler 6",
					"filler 7",
					"filler 8",
					"filler 9",
				],
			}),
		},
	],
	noOutputBleedPastComposer: [
		{
			name: "a transcript row is painted inside the footer zone",
			says: "inside the composer footer zone",
			break: base => withRow(base, 7, "transcript-output-line-0099 bleed past composer"),
		},
		{
			// Below the live content and above the footer: a row the engine has stopped owning, which
			// the footer-zone clause cannot see because it is outside the footer bounds.
			name: "a transcript row is painted past the last content row",
			says: "beyond contentBottom",
			break: base => ({
				...withRow(base, 4, "transcript-output-line-0042 past the content"),
				screenBounds: { ...base.screenBounds, contentBottom: 3 },
			}),
		},
	],
	noMixedTranscriptAndChromeRows: [
		{
			name: "one row carries both the prompt glyph and transcript content",
			says: "mixes transcript content with composer chrome",
			break: base => withRow(base, 7, "  › transcript-output-line-0012 hello"),
		},
		{
			// The chrome half of the clause is the hairline, not only the prompt. A caller whose
			// transcript rows are box art reaches it, and the prompt defect above never does.
			name: "the hairline row is also a transcript row",
			says: "mixes transcript content with composer chrome",
			break: base => ({ ...base, transcriptLineMarkers: ["────"] }),
		},
	],
	footerOccupiesBottomPhysicalRows: [
		{
			name: "the footer stops one row short of the terminal bottom",
			says: "does not reach terminal bottom",
			break: base => ({ ...base, screenBounds: { ...base.screenBounds, footerBottom: 8 } }),
		},
		{
			name: "the footer reaches the bottom but starts a row too high for its height",
			says: "does not match expected top",
			break: base => ({ ...base, screenBounds: { ...base.screenBounds, footerTop: 4 } }),
		},
		{
			// A frame shorter than the screen pins nothing to the bottom: the footer follows the
			// content, so the clause that governs it is a different one from the full-frame case.
			name: "in a short frame the footer does not follow the content",
			says: "must match content bottom",
			break: base => ({
				...base,
				totalFrameRows: 7,
				screenBounds: { ...base.screenBounds, footerBottom: 6, contentBottom: 4 },
			}),
		},
	],
	noFooterRowsAboveFooterRegion: [
		{
			name: "composer chrome is painted above the footer region",
			says: "Composer prompt row found at row 2",
			break: base => withRow(base, 2, "  › leaked prompt in transcript"),
		},
		{
			// The row directly above the footer is allowed to be a hairline, so this has to land
			// higher than that to reach the clause at all.
			name: "a second hairline is painted in the transcript",
			says: "Composer hairline row found at row 2",
			break: base => withRow(base, 2, "─".repeat(80)),
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
		{
			name: "a click on a transcript row is dispatched to a footer child",
			says: "but routed to footer",
			break: base => {
				const mouseRouting = new Map(base.mouseRouting ?? []);
				mouseRouting.set(2, { routedTo: "footer:editor", localLine: 0, col: 0 });
				return { ...base, mouseRouting };
			},
		},
		{
			// Below the last content row and above the footer nothing is painted, so a click there
			// belongs to no component. Routing it to the footer hands the editor a phantom click.
			name: "a click below the last content row is dispatched to a footer child",
			says: "outside active content bounds",
			break: base => {
				const mouseRouting = new Map(base.mouseRouting ?? []);
				mouseRouting.set(4, { routedTo: "footer:editor", localLine: 0, col: 0 });
				return {
					...base,
					mouseRouting,
					screenBounds: { ...base.screenBounds, contentBottom: 3 },
				};
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
		{
			name: "the caret sits at a negative column",
			says: "outside terminal width",
			break: base => ({ ...base, cursor: { row: 7, col: -1 } }),
		},
	],
	noHorizontalOverflow: [
		{
			name: "a row is painted wider than the terminal",
			says: "exceeding terminal width 80",
			break: base => withRow(base, 3, "x".repeat(95)),
		},
		{
			// Forty-one wide glyphs are forty-one characters and eighty-two columns. A check counting
			// characters passes this row; the terminal wraps it.
			name: "a row of wide glyphs fits by character count and overflows by column",
			says: "has visible width 82",
			break: base => withRow(base, 3, "漢".repeat(41)),
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
		{
			name: "the hairline claims no row",
			says: "ComposerHairline segment rowCount is 0",
			break: base => ({
				...base,
				segments: base.segments.map(s => (s.componentName === "ComposerHairline" ? { ...s, rowCount: 0 } : s)),
			}),
		},
	],
	footerHeightMatchesComposedSegmentLedger: [
		{
			name: "the pinned footer height disagrees with its children's rows",
			says: "does not match segment ledger sum",
			break: base => ({ ...base, pinnedFooterRows: 7 }),
		},
		{
			name: "the footer has rows but no children to account for them",
			says: "pinnedFooterChildCount is 0",
			break: base => ({ ...base, pinnedFooterChildCount: 0 }),
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
		{
			name: "a frozen view paints more footer rows than the live footer has",
			says: "live footer expected 3 rows",
			break: base => ({
				...base,
				virtualScrollTop: 2,
				liveFooterLines: (base.liveFooterLines ?? []).slice(0, 3),
			}),
		},
	],
	noStyleBleedPastPaintedText: [
		{
			name: "a background fill runs past the end of the row's text",
			says: "background on column(s)",
			break: base => withStyle(base, 2, "background", [70, 71, 72]),
		},
		{
			name: "a foreground colour is left on the blank cells after the text",
			says: "foreground on column(s)",
			break: base => withStyle(base, 4, "foreground", [60]),
		},
		{
			name: "an underline extends one column past the text",
			says: "underline on column(s)",
			break: base => withStyle(base, 5, "underline", [(base.viewportLines[5] ?? "").length]),
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

/**
 * Guarantees allowed to carry a single crafted defect.
 *
 * Empty, and pinned by exact equality rather than by a count: a check states several ways to fail and
 * one craft exercises one of them, so a guarantee proven able to fail once is not a guarantee proven
 * to cover its statement. A new oracle arriving with one defect turns this red, which is where the
 * second one gets written or the exemption gets argued for.
 */
const SINGLE_CRAFT_EXEMPTIONS: readonly ComposerOracleGuarantee[] = [];

describe("every guarantee has a defect that makes it fail", () => {
	it("files at least one crafted defect for every guarantee", () => {
		const missing = COMPOSER_ORACLE_GUARANTEES.filter(id => DEFECTS[id].length === 0);
		expect([...missing].sort()).toEqual([]);
	});

	it("files more than one for every guarantee, or records why not", () => {
		const single = COMPOSER_ORACLE_GUARANTEES.filter(id => DEFECTS[id].length === 1);
		expect([...single].sort()).toEqual([...SINGLE_CRAFT_EXEMPTIONS].sort());
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
