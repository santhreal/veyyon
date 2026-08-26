/**
 * An overlay is painted where its own lines say it is.
 *
 * WHY THIS SUITE EXISTS:
 * The composer oracles declare an open overlay out of scope, because a modal composites over the very
 * rows they judge. Nothing then judged the modal: one suite proves an overlay that comes and goes
 * leaves the frame as it was, which says nothing about the frame while it is open. This sweep runs the
 * overlay oracles over real `showOverlay` calls across anchors, sizes, margins, offsets, stack depths
 * and terminal geometries.
 *
 * The class it closes: a modal painted somewhere other than where its own rendered lines belong, and
 * a modal that loses content silently. The compositor drops a row whose screen index is out of range
 * without a word and rebuilds every touched line from three padded pieces, so a lost row and a wiped
 * base column are both quiet failures that a frame-restoration test cannot see.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - The layout arithmetic itself. The oracles judge placement invariants that hold whatever the anchor
 *   and percentage maths decided; an anchor that centres wrongly but consistently passes here.
 * - Alt-screen overlays. A fullscreen modal paints on the alternate buffer, which
 *   `an-overlay-that-comes-and-goes-leaves-the-frame-as-it-was.test.ts` covers.
 * - Style. The overlay frame state carries text and geometry, not cell attributes.
 * - Animated exit frames. Each arm settles before the capture.
 *
 * MUTATION GATE (each mutation applied to `packages/tui/src/tui.ts` alone, then restored):
 * 1. `#compositeOverlaysIntoWindow`, row loop from `i = 1`: drops the card's first line.
 *    Red, `everyOverlayRowReachesTheScreen`: "rendered line 0 is missing from screen row 0, which is
 *    inside the viewport".
 * 2. Same method, walking `[...this.overlayStack].reverse()`: paints the stack in the wrong order.
 *    Red, `everyOverlayRowReachesTheScreen` for the fully covered pair and
 *    `overlayLeavesTheBaseFrameOutsideItsColumns` for the half-overlapping one.
 * 3. `#compositeLineAt`, `base.after` replaced by `""`: wipes the base text right of the card.
 *    Red, `overlayLeavesTheBaseFrameOutsideItsColumns`: "right of the overlay reads ''".
 * 4. `#compositeOverlaysIntoWindow`, `col + 1`: shifts every row of the block one column right.
 *    Red on the anchor-edge claims: a left-anchored card at column 1, a right-anchored card at 81.
 *    The oracles alone pass this, which is why those claims exist.
 * 5. Same method, `row + i + 1`: shifts the block one row down. Red on the anchor-edge claims.
 * 6. `if (overlayMarkers.length > 0)` in the render path: ignores the overlay's cursor marker.
 *    Red, `caretLandsWhereTheOverlayAsksForIt`: the caret stays on the composer's editor row.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	locateOverlayBlock,
	OVERLAY_ORACLE_GUARANTEES,
	type OverlayOracleGuarantee,
} from "../src/modes/components/overlay-defect-oracle";
import { initTheme } from "../src/modes/theme/theme";
import { type OverlaySpec, runOverlayOracleScenario } from "./helpers/overlay-oracle-runner";

const CARD = ["┌─ card ─┐", "│ line 1 │", "│ line 2 │", "└────────┘"] as const;
const TALL = Array.from({ length: 14 }, (_, i) => `│ tall row ${String(i).padStart(2, "0")} │`);

/** One arm of the sweep: a geometry and the overlays shown in it. */
interface Arm {
	name: string;
	width: number;
	height: number;
	transcriptLines: number;
	overlays: readonly OverlaySpec[];
}

const ANCHORS = [
	"top-left",
	"top-center",
	"top-right",
	"left-center",
	"center",
	"right-center",
	"bottom-left",
	"bottom-center",
	"bottom-right",
] as const;

const GEOMETRIES = [
	{ width: 80, height: 24, transcriptLines: 8 },
	{ width: 60, height: 12, transcriptLines: 20 },
	{ width: 40, height: 8, transcriptLines: 4 },
] as const;

function arms(): Arm[] {
	const list: Arm[] = [];
	for (const geometry of GEOMETRIES) {
		for (const anchor of ANCHORS) {
			list.push({
				name: `${geometry.width}x${geometry.height} anchor=${anchor}`,
				...geometry,
				overlays: [{ name: "card", lines: CARD, options: { anchor, width: 20 } }],
			});
		}
		// A card taller than the terminal, which the engine clips to `maxHeight` from one end
		// depending on the anchor. The clipped rows are off screen, which the reach guarantee has to
		// account for rather than fail on.
		list.push({
			name: `${geometry.width}x${geometry.height} tall card clipped`,
			...geometry,
			overlays: [{ name: "tall", lines: TALL, options: { anchor: "center", width: 18 } }],
		});
		list.push({
			name: `${geometry.width}x${geometry.height} tall card clipped from the bottom`,
			...geometry,
			overlays: [{ name: "tall", lines: TALL, options: { anchor: "bottom-center", width: 18 } }],
		});
		// A margin and an offset both move the block, and the placement clamps to the terminal.
		list.push({
			name: `${geometry.width}x${geometry.height} margin and offset`,
			...geometry,
			overlays: [
				{
					name: "card",
					lines: CARD,
					options: { anchor: "top-left", width: 16, margin: 2, offsetX: 3, offsetY: 1 },
				},
			],
		});
		// An offset large enough to push the block off the screen, which the clamp has to hold back.
		list.push({
			name: `${geometry.width}x${geometry.height} offset past the edge`,
			...geometry,
			overlays: [
				{ name: "card", lines: CARD, options: { anchor: "bottom-right", width: 16, offsetX: 40, offsetY: 20 } },
			],
		});
		// Two cards, the second over the first, so the stack-order guarantee has a pair.
		list.push({
			name: `${geometry.width}x${geometry.height} two cards stacked`,
			...geometry,
			overlays: [
				{ name: "under", lines: CARD, options: { anchor: "center", width: 20 } },
				{ name: "over", lines: ["« over 1 »", "« over 2 »"], options: { anchor: "center", width: 12, offsetY: 1 } },
			],
		});
		// Two cards that half overlap: the upper one overhangs the lower, so it stays locatable even if
		// the compositor paints them in the wrong order, which is what leaves the stack-order guarantee
		// with something to judge instead of a card that vanished.
		list.push({
			name: `${geometry.width}x${geometry.height} two cards half overlapping`,
			...geometry,
			overlays: [
				{ name: "under", lines: CARD, options: { anchor: "top-left", width: 12 } },
				{
					name: "over",
					lines: ["« over 1 »", "« over 2 »"],
					options: { anchor: "top-left", width: 12, offsetX: 8, offsetY: 1 },
				},
			],
		});
		// A card that asks for the caret, which the engine reads back out of the composited window.
		list.push({
			name: `${geometry.width}x${geometry.height} card with a caret`,
			...geometry,
			overlays: [
				{ name: "input", lines: CARD, options: { anchor: "center", width: 20 }, caret: { line: 1, col: 3 } },
			],
		});
		// A card hidden before the capture: on the stack, painted by nothing. Every guarantee has to
		// treat it as no subject rather than as a clean frame.
		list.push({
			name: `${geometry.width}x${geometry.height} card hidden before capture`,
			...geometry,
			overlays: [{ name: "card", lines: CARD, options: { anchor: "center", width: 20 }, hideBeforeCapture: true }],
		});
	}
	return list;
}

const ARMS = arms();

/** Where one card's block landed, in screen coordinates. */
interface PlacedBlock {
	name: string;
	top: number | null;
	col: number | null;
	bottom: number | null;
	right: number | null;
}

interface ArmOutcome {
	arm: string;
	anchor: string | undefined;
	geometry: { width: number; height: number };
	blocks: PlacedBlock[];
	failures: string[];
	skipped: OverlayOracleGuarantee[];
	inspected: OverlayOracleGuarantee[];
	blind: OverlayOracleGuarantee[];
	visibleOverlays: number;
}

const outcomes: ArmOutcome[] = [];

beforeAll(async () => {
	await initTheme(false);
	for (const arm of ARMS) {
		const run = await runOverlayOracleScenario({
			width: arm.width,
			height: arm.height,
			transcriptLines: arm.transcriptLines,
			editorText: "overlay sweep",
			overlays: arm.overlays,
		});
		try {
			outcomes.push({
				arm: arm.name,
				anchor: arm.overlays[0]?.options?.anchor,
				geometry: { width: arm.width, height: arm.height },
				blocks: run.frameState.overlays
					.filter(overlay => overlay.visible)
					.map(overlay => {
						const block = locateOverlayBlock(run.frameState, overlay);
						const rows = block.rowOf.filter((row): row is number => row !== null);
						return {
							name: overlay.name,
							top: block.top,
							col: block.col,
							bottom: rows.length > 0 ? Math.max(...rows) : null,
							right: block.col === null ? null : block.col + overlay.renderWidth,
						};
					}),
				failures: run.evaluation.failures.map(failure => `${arm.name}: ${failure.oracle}: ${failure.message}`),
				skipped: run.evaluation.skipped,
				inspected: run.evaluation.inspected,
				blind: run.evaluation.blind,
				visibleOverlays: run.frameState.overlays.filter(overlay => overlay.visible).length,
			});
		} finally {
			run.cleanUp();
		}
	}
}, 900_000);

describe("the overlay sweep drove the space it claims", () => {
	it("ran every arm", () => {
		expect(outcomes.map(outcome => outcome.arm)).toEqual(ARMS.map(arm => arm.name));
	});

	it("accounts for every guarantee in every arm", () => {
		for (const outcome of outcomes) {
			const seen = [...outcome.skipped, ...outcome.inspected, ...outcome.blind].sort();
			expect(seen, outcome.arm).toEqual([...OVERLAY_ORACLE_GUARANTEES].sort());
		}
	});
});

describe("an anchored card sits against the edge it was anchored to", () => {
	// The oracles judge placement invariants without recomputing the layout, which leaves one thing
	// they cannot see: a block shifted uniformly, every row of it, by the same amount. An edge anchor
	// with no margin and no offset is where that becomes a contract rather than arithmetic. A card
	// anchored top-left starts at row 0 column 0 or the anchor did not hold.
	const anchored = (predicate: (anchor: string) => boolean): ArmOutcome[] =>
		outcomes.filter(
			outcome =>
				outcome.anchor !== undefined &&
				predicate(outcome.anchor) &&
				(outcome.arm.includes("anchor=") || outcome.arm.endsWith("with a caret")),
		);

	it("puts a left-anchored card in column zero", () => {
		const arms = anchored(anchor => anchor.endsWith("-left"));
		expect(arms.length).toBeGreaterThan(0);
		for (const outcome of arms) {
			expect(outcome.blocks[0]?.col, outcome.arm).toBe(0);
		}
	});

	it("puts a right-anchored card against the right edge", () => {
		const arms = anchored(anchor => anchor.endsWith("-right"));
		expect(arms.length).toBeGreaterThan(0);
		for (const outcome of arms) {
			expect(outcome.blocks[0]?.right, outcome.arm).toBe(outcome.geometry.width);
		}
	});

	it("puts a top-anchored card in row zero", () => {
		const arms = anchored(anchor => anchor.startsWith("top-"));
		expect(arms.length).toBeGreaterThan(0);
		for (const outcome of arms) {
			expect(outcome.blocks[0]?.top, outcome.arm).toBe(0);
		}
	});

	it("puts a bottom-anchored card against the bottom row", () => {
		const arms = anchored(anchor => anchor.startsWith("bottom-"));
		expect(arms.length).toBeGreaterThan(0);
		for (const outcome of arms) {
			expect(outcome.blocks[0]?.bottom, outcome.arm).toBe(outcome.geometry.height - 1);
		}
	});
});

describe("no overlay the engine paints is a defect", () => {
	it("reports no oracle failure in any arm", () => {
		expect(outcomes.flatMap(outcome => outcome.failures)).toEqual([]);
	});
});

describe("the sweep judged a painted modal rather than passing on nothing", () => {
	it("inspected every guarantee somewhere", () => {
		const inspected = new Set(outcomes.flatMap(outcome => outcome.inspected));
		const never = OVERLAY_ORACLE_GUARANTEES.filter(id => !inspected.has(id));
		expect([...never].sort()).toEqual([]);
	});

	it("goes blind only where no overlay is painted", () => {
		for (const outcome of outcomes) {
			if (outcome.blind.length === 0) continue;
			expect(outcome.visibleOverlays, `${outcome.arm} went blind with a painted overlay`).toBe(0);
		}
	});

	it("treats a hidden overlay as out of scope in every guarantee", () => {
		const hidden = outcomes.filter(outcome => outcome.visibleOverlays === 0);
		expect(hidden.length).toBe(GEOMETRIES.length);
		for (const outcome of hidden) {
			expect([...outcome.skipped].sort(), outcome.arm).toEqual([...OVERLAY_ORACLE_GUARANTEES].sort());
		}
	});

	it("judges the caret only where a card asked for it", () => {
		const asked = outcomes.filter(outcome => outcome.arm.endsWith("card with a caret"));
		expect(asked.length).toBe(GEOMETRIES.length);
		for (const outcome of asked) {
			expect(outcome.inspected, outcome.arm).toContain("caretLandsWhereTheOverlayAsksForIt");
		}
		for (const outcome of outcomes.filter(o => !o.arm.endsWith("card with a caret"))) {
			expect(outcome.skipped, outcome.arm).toContain("caretLandsWhereTheOverlayAsksForIt");
		}
	});

	it("compares two stacked cards wherever both are painted", () => {
		const stacked = outcomes.filter(outcome => outcome.arm.includes("two cards"));
		expect(stacked.length).toBe(GEOMETRIES.length * 2);
		for (const outcome of stacked) {
			expect(outcome.inspected, outcome.arm).toContain("topmostOverlayWinsTheOverlap");
		}
	});
});
