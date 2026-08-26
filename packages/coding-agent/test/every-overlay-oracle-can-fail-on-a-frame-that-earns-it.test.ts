/**
 * Every overlay defect oracle can fail, through the evaluator rather than by being called by hand.
 *
 * WHY THIS SUITE EXISTS:
 * A new oracle family is worth nothing until each of its guarantees has been seen to fail on a frame
 * that earns it. The composer registry taught this twice: an `appliesTo` that rejects the state its
 * own defect lives in reports the defect as out of scope, and a subject that is empty reports no
 * verdict at all. Both read as a pass to anything looking at `passed`.
 *
 * The class this closes: an overlay guarantee that is declared, wired, and incapable of failing. The
 * cases are filed in a `Record` over the guarantee union, so a seventh oracle without a crafted
 * defect does not compile, and each case pins a phrase of the failure message so a craft that fires
 * on a different branch than intended is caught rather than counted.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether a real mount can produce these frames. They are synthetic. The sweep in
 *   `an-overlay-is-painted-where-its-own-lines-say-it-is.test.ts` drives real overlays through
 *   `showOverlay` and is what proves the oracles judge the engine rather than a hand-built grid.
 * - Over-triggering. A crafted frame may fail several guarantees and only the one under test is
 *   asserted; the sweep is what proves a correct frame fails nothing.
 */

import { describe, expect, it } from "bun:test";
import {
	evaluateAllOverlayOracles,
	OVERLAY_ORACLE_GUARANTEES,
	type OverlayOracleFrameState,
	type OverlayOracleGuarantee,
} from "../src/modes/components/defect-oracles";

const CARD = ["┌── card ──┐", "│ line one │", "│ line two │", "└──────────┘"] as const;
const CARD_WIDTH = 12;
const CARD_TOP = 3;
const CARD_COL = 4;

/** A frame with one card painted over a transcript, exactly where its own lines say it is. */
function createBaselineFrameState(): OverlayOracleFrameState {
	const width = 40;
	const height = 10;
	const base = Array.from({ length: height }, (_, row) => `base row ${row} ${"-".repeat(20)}`);
	const viewportLines = [...base];
	for (let i = 0; i < CARD.length; i++) {
		const row = CARD_TOP + i;
		const line = base[row] ?? "";
		viewportLines[row] = `${line.slice(0, CARD_COL)}${CARD[i]}${line.slice(CARD_COL + CARD_WIDTH)}`;
	}

	return {
		width,
		height,
		viewportLines,
		baseViewportLines: base,
		cursor: { row: CARD_TOP + 1, col: CARD_COL + 3 },
		overlays: [
			{
				stackIndex: 0,
				name: "card",
				renderedLines: [...CARD],
				renderWidth: CARD_WIDTH,
				visible: true,
				interactive: true,
				caretRequest: { line: 1, col: 3 },
			},
		],
	};
}

/** Replace one screen row of the composited frame. */
function withRow(state: OverlayOracleFrameState, row: number, line: string): OverlayOracleFrameState {
	const viewportLines = [...state.viewportLines];
	viewportLines[row] = line;
	return { ...state, viewportLines };
}

interface DefectCase {
	name: string;
	says: string;
	break(base: OverlayOracleFrameState): OverlayOracleFrameState;
}

const DEFECTS: Readonly<Record<OverlayOracleGuarantee, readonly DefectCase[]>> = {
	overlayRowsPaintContiguouslyInOrder: [
		{
			name: "the last card row is painted two rows below where the block puts it",
			says: "but line 2 at screen row",
			break: base => {
				const moved = withRow(base, CARD_TOP + 3, base.baseViewportLines[CARD_TOP + 3] ?? "");
				const target = CARD_TOP + 5;
				const line = moved.viewportLines[target] ?? "";
				return withRow(moved, target, `${line.slice(0, CARD_COL)}${CARD[3]}${line.slice(CARD_COL + CARD_WIDTH)}`);
			},
		},
		{
			name: "one card row is painted a column to the right of the others",
			says: "starting at column 5, and its other lines start at 4",
			break: base => {
				const line = base.baseViewportLines[CARD_TOP + 2] ?? "";
				return withRow(
					base,
					CARD_TOP + 2,
					`${line.slice(0, CARD_COL + 1)}${CARD[2]}${line.slice(CARD_COL + 1 + CARD_WIDTH)}`,
				);
			},
		},
	],
	everyOverlayRowReachesTheScreen: [
		{
			name: "a middle row of the card never reaches the screen",
			says: "is missing from screen row 5, which is inside the viewport",
			break: base => withRow(base, CARD_TOP + 2, base.baseViewportLines[CARD_TOP + 2] ?? ""),
		},
	],
	overlayLeavesTheBaseFrameOutsideItsColumns: [
		{
			name: "the card wipes the base text to its right",
			says: "right of the overlay reads",
			break: base => {
				const line = base.viewportLines[CARD_TOP] ?? "";
				return withRow(base, CARD_TOP, line.slice(0, CARD_COL + CARD_WIDTH));
			},
		},
		{
			name: "the card shifts the base text to its left",
			says: "left of the overlay reads",
			break: base => {
				const line = base.viewportLines[CARD_TOP + 1] ?? "";
				return withRow(base, CARD_TOP + 1, ` ${line.slice(1)}`);
			},
		},
	],
	overlayBlockStaysInsideTheViewport: [
		{
			name: "a card row is painted past the terminal width",
			says: "past the terminal width",
			break: base => {
				const line = base.viewportLines[CARD_TOP] ?? "";
				return withRow(base, CARD_TOP, `${line}${"x".repeat(10)}`);
			},
		},
	],
	caretLandsWhereTheOverlayAsksForIt: [
		{
			name: "the caret is left in the composer under a modal that asked for it",
			says: "and it is at row 9 column 2",
			break: base => ({ ...base, cursor: { row: 9, col: 2 } }),
		},
		{
			name: "the caret lands one column left of the cell the modal asked for",
			says: "and it is at row 4 column 6",
			break: base => ({ ...base, cursor: { row: CARD_TOP + 1, col: CARD_COL + 2 } }),
		},
		{
			name: "the modal asked for a caret and there is none",
			says: "and there is no caret",
			break: base => ({ ...base, cursor: null }),
		},
	],
	topmostOverlayWinsTheOverlap: [
		{
			// The upper card is located by the line that overhangs the lower one, and the row they share
			// still shows the lower card's text: the compositor painted the stack in reverse.
			name: "the row two cards share shows the lower one",
			says: "which 'second' above it also occupies",
			break: base => {
				const overlapRow = CARD_TOP + 1;
				const anchorRow = CARD_TOP + 4;
				const anchor = base.viewportLines[anchorRow] ?? "";
				const withAnchor = withRow(
					base,
					anchorRow,
					`${anchor.slice(0, CARD_COL)}second-2${anchor.slice(CARD_COL + 8)}`,
				);
				return {
					...withAnchor,
					overlays: [
						...withAnchor.overlays,
						{
							stackIndex: 1,
							name: "second",
							renderedLines: ["second-1", "second-2"],
							renderWidth: 8,
							visible: true,
							interactive: true,
							caretRequest: null,
						},
					],
					cursor: { row: overlapRow, col: CARD_COL + 1 },
				};
			},
		},
	],
};

/** Guarantees allowed to carry a single crafted defect, pinned rather than counted. */
const SINGLE_CRAFT_EXEMPTIONS: readonly OverlayOracleGuarantee[] = [
	"everyOverlayRowReachesTheScreen",
	"overlayBlockStaysInsideTheViewport",
	"topmostOverlayWinsTheOverlap",
];

describe("the baseline overlay frame is the control", () => {
	it("fails nothing, and goes blind nowhere it applies", () => {
		const result = evaluateAllOverlayOracles(createBaselineFrameState());
		expect(result.failures).toEqual([]);
		expect(result.blind).toEqual([]);
		// One card, so the stack-order guarantee has no pair to compare and is out of scope. Pinned by
		// exact equality: a guarantee that quietly stops applying to a plain frame stops being enforced.
		expect([...result.skipped].sort()).toEqual(["topmostOverlayWinsTheOverlap"]);
	});

	it("locates the card where the frame painted it", () => {
		const result = evaluateAllOverlayOracles(createBaselineFrameState());
		expect([...result.inspected].sort()).toEqual(
			[...OVERLAY_ORACLE_GUARANTEES].filter(id => id !== "topmostOverlayWinsTheOverlap").sort(),
		);
	});

	it("reports a hidden overlay as no subject rather than as a clean frame", () => {
		const base = createBaselineFrameState();
		const hidden: OverlayOracleFrameState = {
			...base,
			overlays: base.overlays.map(overlay => ({ ...overlay, visible: false, interactive: false })),
		};
		const result = evaluateAllOverlayOracles(hidden);
		expect(result.inspected).toEqual([]);
		expect([...result.skipped].sort()).toEqual([...OVERLAY_ORACLE_GUARANTEES].sort());
	});

	it("reports an overlay that reached the screen nowhere as blind or failing, never as clean", () => {
		const base = createBaselineFrameState();
		const unpainted: OverlayOracleFrameState = { ...base, viewportLines: base.baseViewportLines };
		const result = evaluateAllOverlayOracles(unpainted);
		const failed = result.failures.map(failure => failure.oracle);
		expect([...result.blind, ...failed].length).toBeGreaterThan(0);
		// The guarantee that exists for this state has to be the one that speaks: a block located
		// nowhere leaves every other check with nothing to read.
		expect(result.blind).toContain("overlayRowsPaintContiguouslyInOrder");
		expect(failed).toContain("everyOverlayRowReachesTheScreen");
	});
});

describe("every overlay guarantee has a defect that makes it fail", () => {
	it("files at least one crafted defect for every guarantee", () => {
		const missing = OVERLAY_ORACLE_GUARANTEES.filter(id => DEFECTS[id].length === 0);
		expect([...missing].sort()).toEqual([]);
	});

	it("files more than one for every guarantee, or records why not", () => {
		const single = OVERLAY_ORACLE_GUARANTEES.filter(id => DEFECTS[id].length === 1);
		expect([...single].sort()).toEqual([...SINGLE_CRAFT_EXEMPTIONS].sort());
	});

	for (const id of OVERLAY_ORACLE_GUARANTEES) {
		for (const defect of DEFECTS[id]) {
			it(`${id}: ${defect.name}`, () => {
				const result = evaluateAllOverlayOracles(defect.break(createBaselineFrameState()));
				const failure = result.failures.find(f => f.oracle === id);
				expect(
					failure,
					`${id} reported no failure on its own defect. skipped=[${result.skipped.join(", ")}] blind=[${result.blind.join(", ")}]`,
				).toBeDefined();
				if (!failure) return;
				expect(failure.message).toContain(defect.says);
			});
		}
	}
});
