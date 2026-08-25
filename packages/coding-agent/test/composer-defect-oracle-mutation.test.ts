/**
 * Mutation Gate Verification Suite for Composer Defect Oracles.
 *
 * WHY THIS SUITE EXISTS:
 * An oracle that cannot fail is worthless. Every one of the 12 named composer defect
 * oracles must be shown going red against a real defect before it counts. This suite
 * synthesizes real defect mutations across every guarantee and asserts that each
 * oracle triggers red for the exact right reason.
 *
 * GUARANTEES TESTED:
 * 1. exactlyOneComposerPrompt
 * 2. noOutputBleedPastComposer
 * 3. noMixedTranscriptAndChromeRows
 * 4. footerOccupiesBottomPhysicalRows
 * 5. noFooterRowsAboveFooterRegion
 * 6. mouseClickRoutesToRenderedZone
 * 7. caretWithinComposerEditorBounds
 * 8. noHorizontalOverflow
 * 9. composerCardPadsAreUnpaintedAir
 * 10. composerHairlineSpanAndPlacement
 * 11. footerHeightMatchesComposedSegmentLedger
 * 12. virtualScrollPreservesFooterStability
 */

import { describe, expect, it } from "bun:test";
import {
	type ComposerOracleFrameState,
	checkCaretWithinComposerEditorBounds,
	checkComposerCardPadsAreUnpaintedAir,
	checkComposerHairlineSpanAndPlacement,
	checkExactlyOneComposerPrompt,
	checkFooterHeightMatchesComposedSegmentLedger,
	checkFooterOccupiesBottomPhysicalRows,
	checkMouseClickRoutesToRenderedZone,
	checkNoFooterRowsAboveFooterRegion,
	checkNoHorizontalOverflow,
	checkNoMixedTranscriptAndChromeRows,
	checkNoOutputBleedPastComposer,
	checkVirtualScrollPreservesFooterStability,
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

function mutateViewportLine(state: ComposerOracleFrameState, row: number, line: string): ComposerOracleFrameState {
	const viewportLines = [...state.viewportLines];
	viewportLines[row] = line;
	const rawViewportLines = [...state.rawViewportLines];
	rawViewportLines[row] = line;
	return { ...state, viewportLines, rawViewportLines };
}

describe("composer defect oracle mutation gates", () => {
	it("baseline frame passes all 12 oracles", () => {
		const state = createBaselineFrameState();
		const result = evaluateAllComposerOracles(state);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it("1. exactlyOneComposerPrompt goes red on duplicate prompt or missing prompt", () => {
		const base = createBaselineFrameState();
		// Mutate: inject a second prompt row
		const state = mutateViewportLine(base, 2, "  › duplicate prompt row");
		const failure = checkExactlyOneComposerPrompt(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("exactlyOneComposerPrompt");
		expect(failure?.message).toContain("Expected 1 composer prompt row(s)");

		// Mutate: missing prompt
		const missingState = mutateViewportLine(base, 7, "  just plain text without prompt");
		const missingFailure = checkExactlyOneComposerPrompt(missingState);
		expect(missingFailure).not.toBeNull();
		expect(missingFailure?.oracle).toBe("exactlyOneComposerPrompt");
	});

	it("2. noOutputBleedPastComposer goes red when transcript bleeds into footer region", () => {
		const base = createBaselineFrameState();
		// Mutate: transcript output injected at screen row 7 (inside footer)
		const state = mutateViewportLine(base, 7, "transcript-output-line-0099 bleed past composer");
		const failure = checkNoOutputBleedPastComposer(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("noOutputBleedPastComposer");
		expect(failure?.message).toContain("inside the composer footer zone");
	});

	it("3. noMixedTranscriptAndChromeRows goes red when prompt and transcript are mixed on one row", () => {
		const base = createBaselineFrameState();
		// Mutate: mix transcript line prefix with composer prompt
		const state = mutateViewportLine(base, 7, "  › transcript-output-line-0012 hello");
		const failure = checkNoMixedTranscriptAndChromeRows(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("noMixedTranscriptAndChromeRows");
		expect(failure?.message).toContain("mixes transcript content with composer chrome");
	});

	it("4. footerOccupiesBottomPhysicalRows goes red when footer does not dock to bottom", () => {
		const base = createBaselineFrameState();
		// Mutate: footer bottom is row 8 instead of row 9
		const state = {
			...base,
			screenBounds: {
				...base.screenBounds,
				footerBottom: 8,
			},
		};
		const failure = checkFooterOccupiesBottomPhysicalRows(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("footerOccupiesBottomPhysicalRows");
		expect(failure?.message).toContain("does not reach terminal bottom");
	});

	it("5. noFooterRowsAboveFooterRegion goes red when footer chrome leaks into transcript region", () => {
		const base = createBaselineFrameState();
		// Mutate: prompt appears at row 2 (transcript region)
		const state = mutateViewportLine(base, 2, "  › leaked prompt in transcript");
		const failure = checkNoFooterRowsAboveFooterRegion(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("noFooterRowsAboveFooterRegion");
		expect(failure?.message).toContain("Composer prompt row found at row 2");
	});

	it("6. mouseClickRoutesToRenderedZone goes red on misrouted footer clicks", () => {
		const base = createBaselineFrameState();
		// Mutate: click on footer row 7 routes to transcript instead of footer component
		const mouseRouting = new Map(base.mouseRouting ?? []);
		mouseRouting.set(7, { routedTo: "transcript", localLine: null, col: null });
		const state = { ...base, mouseRouting };
		const failure = checkMouseClickRoutesToRenderedZone(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("mouseClickRoutesToRenderedZone");
		expect(failure?.message).toContain("is inside footer bounds [5..9] but routed to transcript");
	});

	it("7. caretWithinComposerEditorBounds goes red when cursor is out of bounds", () => {
		const base = createBaselineFrameState();
		// Mutate: cursor col exceeds terminal width
		const colState = { ...base, cursor: { row: 7, col: 85 } };
		const failure = checkCaretWithinComposerEditorBounds(colState);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("caretWithinComposerEditorBounds");
		expect(failure?.message).toContain("outside terminal width");

		// Mutate: cursor placed in transcript region
		const rowState = { ...base, cursor: { row: 2, col: 5 } };
		const rowFailure = checkCaretWithinComposerEditorBounds(rowState);
		expect(rowFailure).not.toBeNull();
		expect(rowFailure?.oracle).toBe("caretWithinComposerEditorBounds");
		expect(rowFailure?.message).toContain("outside footer screen row bounds");
	});

	it("8. noHorizontalOverflow goes red when a rendered row exceeds terminal width", () => {
		const base = createBaselineFrameState();
		// Mutate: line exceeds 80 columns
		const state = mutateViewportLine(base, 3, "x".repeat(95));
		const failure = checkNoHorizontalOverflow(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("noHorizontalOverflow");
		expect(failure?.message).toContain("exceeding terminal width 80");
	});

	it("9. composerCardPadsAreUnpaintedAir goes red when padding contains background fill or text", () => {
		const base = createBaselineFrameState();
		// Mutate: CardPadRow contains text
		const state = mutateViewportLine(base, 6, "leaked text in padding");
		const failure = checkComposerCardPadsAreUnpaintedAir(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("composerCardPadsAreUnpaintedAir");
		expect(failure?.message).toContain("has non-blank content or background styling");

		// Mutate: CardPadRow has background ANSI escape
		const rawViewportLines = [...base.rawViewportLines];
		rawViewportLines[6] = "\x1b[48;2;255;0;0m   \x1b[0m";
		const viewportLines = [...base.viewportLines];
		viewportLines[6] = "";
		const ansiState = { ...base, rawViewportLines, viewportLines };
		const ansiFailure = checkComposerCardPadsAreUnpaintedAir(ansiState);
		expect(ansiFailure).not.toBeNull();
		expect(ansiFailure?.oracle).toBe("composerCardPadsAreUnpaintedAir");
	});

	it("10. composerHairlineSpanAndPlacement goes red when hairline row count is corrupted", () => {
		const base = createBaselineFrameState();
		// Mutate: hairline segment has rowCount 2
		const segments = base.segments.map(s =>
			s.componentName === "ComposerHairline" ? { ...s, rowCount: 2 } : { ...s },
		);
		const state = { ...base, segments };
		const failure = checkComposerHairlineSpanAndPlacement(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("composerHairlineSpanAndPlacement");
		expect(failure?.message).toContain("ComposerHairline segment rowCount is 2, expected exactly 1");
	});

	it("11. footerHeightMatchesComposedSegmentLedger goes red when pinned rows and segment ledger diverge", () => {
		const base = createBaselineFrameState();
		// Mutate: pinnedFooterRows does not match sum of segments
		const state = { ...base, pinnedFooterRows: 7 };
		const failure = checkFooterHeightMatchesComposedSegmentLedger(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("footerHeightMatchesComposedSegmentLedger");
		expect(failure?.message).toContain("does not match segment ledger sum");
	});

	it("12. virtualScrollPreservesFooterStability goes red when virtual scroll footer diverges from live footer", () => {
		const base = createBaselineFrameState();
		// Mutate: enable virtual scroll and tamper with rendered footer row
		const state = {
			...mutateViewportLine(base, 7, "  › corrupted virtual scroll footer row"),
			virtualScrollTop: 2,
		};
		const failure = checkVirtualScrollPreservesFooterStability(state);
		expect(failure).not.toBeNull();
		expect(failure?.oracle).toBe("virtualScrollPreservesFooterStability");
		expect(failure?.message).toContain("differs from live footer");
	});
});
