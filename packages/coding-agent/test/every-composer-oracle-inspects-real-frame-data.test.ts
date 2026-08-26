/**
 * A green composer oracle verdict means every guarantee was checked, not skipped.
 *
 * WHY THIS SUITE EXISTS:
 * Eight of the twelve fields an oracle reads are optional on `ComposerOracleFrameState`, and
 * most of the predicates return null when the field they need is absent or empty. A sweep of
 * four thousand states that all pass therefore has two readings: the composer is correct, or the
 * extraction handed the oracles nothing to look at. The mutation suite proves each predicate
 * fires on a crafted frame state; it says nothing about a frame state built from a real mount.
 * This suite pins, per guarantee, the input that must be present for its verdict to mean
 * anything, and asserts that a real mount supplies it.
 *
 * It also covers the reproduction path for a written case: the sweep records a failing state as
 * JSON, and a state that does not round-trip cannot be replayed, which is how a corpus becomes
 * a set of files nobody can act on.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether the extracted values are CORRECT, only that they are present. A `mouseRouting` map
 *   full of wrong rows satisfies this suite; the oracles and the sweep judge the values.
 * - Guarantees whose inputs exist but whose semantics the runner drives trivially. The bleed
 *   markers are synthetic (`transcript-output-line-`), so oracles 2 and 3 are checked against
 *   content the runner emits rather than against real tool output.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import {
	COMPOSER_ORACLE_GUARANTEES,
	type ComposerOracleFrameState,
	type ComposerOracleGuarantee,
} from "../src/modes/components/composer-defect-oracle";
import { initTheme } from "../src/modes/theme/theme";
import { type RunnerOptions, runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import { corpusStateToRunnerOptions, runnerOptionsToCorpusState } from "./helpers/renderer-defect-corpus";

/** Which mount exercises a guarantee: live tail, or scrolled back under scroll isolation. */
type Mount = "liveTail" | "scrolledBack";

interface InputRequirement {
	/** The reading this oracle would return without inspecting anything. */
	vacuousWhen: string;
	/** True when the frame carries the data the predicate reads. */
	hasInputs: (state: ComposerOracleFrameState) => boolean;
	mount: Mount;
}

const hasVisibleTranscript = (state: ComposerOracleFrameState): boolean => {
	const markers = state.transcriptLineMarkers ?? [];
	if (markers.length === 0) return false;
	return state.viewportLines.some(line => markers.some(marker => line.includes(marker)));
};

const hasSegment = (state: ComposerOracleFrameState, componentName: string): boolean =>
	state.segments.some(s => s.componentName === componentName && s.rowCount > 0);

const REQUIREMENTS: Record<ComposerOracleGuarantee, InputRequirement> = {
	exactlyOneComposerPrompt: {
		vacuousWhen: "no prompt glyph is recorded, so no row can be identified as a prompt",
		hasInputs: state => state.expectedPromptGlyph !== undefined && state.viewportLines.length > 0,
		mount: "liveTail",
	},
	noOutputBleedPastComposer: {
		vacuousWhen: "no transcript-marked row is on screen, so there is nothing that could bleed",
		hasInputs: hasVisibleTranscript,
		mount: "liveTail",
	},
	noMixedTranscriptAndChromeRows: {
		vacuousWhen: "no transcript-marked row is on screen, so no row can mix the two",
		hasInputs: hasVisibleTranscript,
		mount: "liveTail",
	},
	footerOccupiesBottomPhysicalRows: {
		vacuousWhen: "the footer occupies no rows, so it trivially reaches the bottom",
		hasInputs: state => state.pinnedFooterRows > 0,
		mount: "liveTail",
	},
	noFooterRowsAboveFooterRegion: {
		vacuousWhen: "the footer starts at row 0, so there is no region above it to scan",
		hasInputs: state => state.screenBounds.footerTop > 0,
		mount: "liveTail",
	},
	mouseClickRoutesToRenderedZone: {
		vacuousWhen: "footer rows are absent from the routing map, so their clicks are never judged",
		hasInputs: state => {
			const routing = state.mouseRouting;
			if (!routing || routing.size === 0) return false;
			const { footerTop, footerBottom } = state.screenBounds;
			for (let row = footerTop; row <= footerBottom; row += 1) {
				if (!routing.has(row)) return false;
			}
			return true;
		},
		mount: "liveTail",
	},
	caretWithinComposerEditorBounds: {
		vacuousWhen: "the editor is unfocused or the cursor is null, and the check is skipped",
		hasInputs: state => state.editorFocused === true && state.cursor !== null,
		mount: "liveTail",
	},
	noHorizontalOverflow: {
		vacuousWhen: "no row is rendered, so no row can exceed the width",
		hasInputs: state => state.viewportLines.length > 0 && state.width > 0,
		mount: "liveTail",
	},
	composerCardPadsAreUnpaintedAir: {
		vacuousWhen: "the ledger records no CardPadRow, so no padding row is ever inspected",
		hasInputs: state => hasSegment(state, "CardPadRow"),
		mount: "liveTail",
	},
	composerHairlineSpanAndPlacement: {
		vacuousWhen: "the ledger records no ComposerHairline, so its span is never checked",
		hasInputs: state => hasSegment(state, "ComposerHairline"),
		mount: "liveTail",
	},
	footerHeightMatchesComposedSegmentLedger: {
		vacuousWhen: "no footer child is pinned, so the ledger sum and the footer height are both 0",
		hasInputs: state => state.pinnedFooterChildCount > 0 && state.segments.length > 0,
		mount: "liveTail",
	},
	virtualScrollPreservesFooterStability: {
		vacuousWhen: "virtual scroll is inactive, so there is no scrolled frame to compare",
		hasInputs: state => state.virtualScrollTop !== null && (state.liveFooterLines?.length ?? 0) > 0,
		mount: "scrolledBack",
	},
	noSgrLeftOpenAtRowEnd: {
		vacuousWhen: "the raw grid is empty, so there is no row whose escape sequences could be unbalanced",
		hasInputs: state => state.rawViewportLines.length > 0,
		mount: "liveTail",
	},
};

const MOUNTS: Record<Mount, RunnerOptions> = {
	liveTail: {
		width: 80,
		height: 24,
		transcriptLines: 60,
		editorText: "explain quantum computing",
		scrollIsolation: false,
		focused: true,
	},
	scrolledBack: {
		width: 80,
		height: 24,
		transcriptLines: 120,
		editorText: "explain quantum computing",
		scrollIsolation: true,
		scrollOffset: 3,
		focused: true,
	},
};

describe("every composer oracle inspects real frame data", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	/**
	 * Fail by default on a new guarantee. Adding an oracle without stating how it could pass
	 * without looking at anything turns this red, rather than quietly widening a green sweep.
	 */
	it("records an input requirement for every named guarantee", () => {
		expect(Object.keys(REQUIREMENTS).sort()).toEqual([...COMPOSER_ORACLE_GUARANTEES].sort());
	});

	for (const mount of Object.keys(MOUNTS) as Mount[]) {
		const guarantees = COMPOSER_ORACLE_GUARANTEES.filter(g => REQUIREMENTS[g].mount === mount);

		it(`supplies inputs for ${guarantees.length} guarantee(s) on a ${mount} mount`, async () => {
			const result = await runComposerOracleScenario(MOUNTS[mount]);
			try {
				const starved = guarantees
					.filter(g => !REQUIREMENTS[g].hasInputs(result.frameState))
					.map(g => `${g}: ${REQUIREMENTS[g].vacuousWhen}`);
				expect(starved).toEqual([]);
			} finally {
				result.cleanUp();
			}
		});
	}
	/**
	 * This table and the registry's `subject` are two independent statements about what an oracle
	 * needs, written from opposite sides: this one from the frame, the registry's from the check. They
	 * are allowed to differ in strictness, but not to contradict each other. A `subject` narrowed to
	 * something the frame does not carry, while the table still says the data is there, is the drift
	 * that made two oracles inspect nothing, so it is asserted rather than reviewed.
	 */
	for (const mount of Object.keys(MOUNTS) as Mount[]) {
		it(`agrees with the registry about what a ${mount} mount supplies`, async () => {
			const result = await runComposerOracleScenario(MOUNTS[mount]);
			try {
				const contradictions = COMPOSER_ORACLE_GUARANTEES.filter(
					g => REQUIREMENTS[g].hasInputs(result.frameState) && result.evaluation.blind.includes(g),
				).map(g => `${g}: the frame carries its inputs, and the registry read nothing`);
				expect(contradictions).toEqual([]);
			} finally {
				result.cleanUp();
			}
		});
	}

	/**
	 * A written case is only useful if it can be turned back into the mount that produced it.
	 * The dropped set is pinned by exact equality, so a new `RunnerOptions` field that the sweep
	 * varies and the corpus mapping forgets turns this red instead of writing cases that replay
	 * as a different scenario.
	 */
	it("round-trips every swept runner option through the corpus state, dropping only the one it cannot carry", () => {
		const populated: RunnerOptions = {
			width: 40,
			height: 12,
			modeState: { bypass: true, thinkingLevel: ThinkingLevel.High },
			editorText: "line 1\nline 2",
			transcriptLines: 7,
			scrollIsolation: true,
			scrollOffset: 2,
			focused: false,
			statusMessage: "working",
			customParts: {},
		};

		const round = corpusStateToRunnerOptions(runnerOptionsToCorpusState(populated));
		const dropped = Object.keys(populated).filter(key => round[key as keyof RunnerOptions] === undefined);
		expect(dropped).toEqual(["customParts"]);

		expect(round.width).toBe(40);
		expect(round.height).toBe(12);
		expect(round.editorText).toBe("line 1\nline 2");
		expect(round.transcriptLines).toBe(7);
		expect(round.scrollIsolation).toBe(true);
		expect(round.scrollOffset).toBe(2);
		expect(round.focused).toBe(false);
		expect(round.modeState?.bypass).toBe(true);
		expect(round.modeState?.thinkingLevel).toBe(ThinkingLevel.High);
	});

	/**
	 * The segment ledger the oracles judge is derived from the root children the tui holds, and each
	 * one is re-rendered to count its rows. Cross-checking the total against `TUI.composedFrameRows`
	 * -- the engine's own count of the frame it composed -- is what stops the ledger from describing
	 * a frame the engine did not paint. Without it, a component whose row count depends on frame
	 * context leaves the three ledger oracles comparing a reconstruction to itself and passing on
	 * every state.
	 */
	it("rebuilds a segment ledger that agrees with the frame the engine composed", async () => {
		const result = await runComposerOracleScenario(MOUNTS.liveTail);
		try {
			const ledgerSum = result.frameState.segments.reduce((sum, segment) => sum + segment.rowCount, 0);
			expect(result.frameState.totalFrameRows).toBe(ledgerSum);
			expect(ledgerSum).toBe(result.tui.composedFrameRows);
		} finally {
			result.cleanUp();
		}
	});
});
