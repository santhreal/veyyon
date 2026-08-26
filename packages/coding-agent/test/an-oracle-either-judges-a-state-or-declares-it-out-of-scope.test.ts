/**
 * Every composer oracle either reads a non-empty subject and reaches a verdict, or declares the
 * state out of its scope. Nothing in between.
 *
 * WHY THIS SUITE EXISTS:
 * Two defects in this module were the same defect: an oracle that inspected nothing and reported
 * success. The padding oracle mapped a footer segment through the content formula and landed past
 * the bottom of the viewport, so its own range guard dropped every row it meant to judge. The bleed
 * oracle looked for a transcript marker that five of the six row flavours never carry, so it matched
 * zero rows. Both walked out through the bottom of a function returning `null`, which the evaluator
 * counted as a pass, and a sweep of four thousand states reported clean while the guarantees went
 * unchecked. A wrong answer gets investigated; a blank one does not.
 *
 * The registry answers that by splitting the outcome three ways: `skipped` for a state outside an
 * oracle's scope, `inspected` for a subject it actually read, `blind` for the hole. This suite pins
 * every part of that split at run time from `COMPOSER_ORACLE_GUARANTEES`, so a thirteenth oracle
 * joins the sweep by existing, and one that inspects nothing anywhere turns the suite red.
 *
 * The matrix runs six row flavours over three terminal widths, six heights from four rows to
 * twenty-four, three transcript depths, both scroll offsets, both isolation settings and both focus
 * states. Narrow terminals are in it because truncation is decided there. Short terminals are in it
 * because they are the states where an oracle legitimately loses its subject: a
 * terminal that cannot hold the whole composer shows none of its padding rows, and the oracle that
 * judges them has nothing to read. That makes the flat list of ever-blind oracles too weak on its
 * own, so a second claim requires each blind verdict to have a reason in the state that produced it,
 * read from the ledger's frame-row indices rather than from the screen mapping the oracles use. A
 * padding oracle blind to a pad the frame puts on screen is the original defect, and a pin that only
 * lists names cannot see it.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether an oracle's verdict is correct. A subject can be non-empty and the judgement on it still
 *   wrong; that is what the sweep, the differential and the per-guarantee suites are for.
 * - Whether a subject is the *right* subject. `subject()` states what `run()` reads by declaration,
 *   not by instrumentation, so an oracle whose body reads fewer rows than it declares looks healthy
 *   here. `a-frozen-view-maps-every-segment-to-the-row-it-paints-on` covers the mapping that made
 *   the declaration wrong once.
 * - Why a state is blind beyond the geometry the reasons table names. A row flavour that stopped
 *   painting a recognisable marker would satisfy the depth reason and go unnoticed here;
 *   `an-oracle-that-cannot-see-its-subject-is-a-hole` owns that.
 * - Overlays, transitions and replay. This suite mounts cold states only.
 *
 * MUTATION GATE (all against the final code, each restored before the next):
 * 1. `appliesTo: () => true` on `footerOccupiesBottomPhysicalRows`: the frozen-class skip pin goes
 *    red, because the oracle stops declaring the frozen states it cannot judge.
 * 2. `subject: () => ({ kind: "rows", rows: [] })` on `noHorizontalOverflow`: the ever-blind pin and
 *    the always-inspected pin both go red, naming the oracle.
 * 3. Dropping the range clamp in `screenRowForSegment`: pad rows map past the viewport again, and the
 *    deep-transcript no-blind claim goes red for `composerCardPadsAreUnpaintedAir`.
 * 4. Returning `screenRowForSegment` to the live-tail mapping for every segment: the geometric claim
 *    goes red, naming each state where the frame put a pad on screen and the oracle read nothing. The
 *    flat ever-blind pin stays green through it, which is why the second claim exists.
 * 5. Replacing the pad reason with `state.totalFrameRows <= height`: the same mutation stays green,
 *    because a composer that overflows the terminal then excuses the blindness the defect caused.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	COMPOSER_ORACLE_GUARANTEES,
	COMPOSER_ORACLES,
	type ComposerOracleGuarantee,
	subjectSize,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import { contentLines, FLAVOR_MARK, FLAVORS, ISOLATION, MODE_STATES } from "./helpers/renderer-differential";

const DEPTHS = [0, 4, 30] as const;

/**
 * Short terminals are in the matrix because they are where an oracle loses its subject for a reason
 * the geometry accounts for, which is the only blindness that is not a defect.
 */
const HEIGHTS = [4, 6, 8, 10, 16, 24] as const;

/**
 * Narrow terminals are in the matrix because truncation and overflow are decided there, and a subject
 * an oracle reads at eighty columns can be shortened away at forty.
 */
const WIDTHS = [40, 80, 120] as const;

const OFFSETS = [0, 5] as const;
const FOCUS = [true, false] as const;

/** One swept state, keeping the inputs that decide what an oracle should be able to see. */
interface Record_ {
	name: string;
	/** Transcript rows the scenario asked for. An input, not a reading of the painted frame. */
	depth: number;
	height: number;
	/** Whether the wheel was turned, which is what freezes the view. */
	offset: number;
	frozen: boolean;
	skipped: readonly ComposerOracleGuarantee[];
	inspected: readonly ComposerOracleGuarantee[];
	blind: readonly ComposerOracleGuarantee[];
	/**
	 * Screen rows above the pinned footer. Zero means the composer fills the terminal, so no transcript
	 * row is on screen for a transcript oracle to read whatever the depth is.
	 */
	contentRowsOnScreen: number;
	/**
	 * Whether every CardPadRow's frame rows lie inside the last `height` rows of the frame, which is
	 * the band a terminal shows. Computed from the ledger's own row indices rather than from
	 * `screenRowForSegment`, so it is an independent second opinion on whether the padding was on
	 * screen at all: an oracle blind to a pad this says is visible has lost the row, not the frame.
	 */
	padWithinVisibleTail: boolean;
	/** Failures the skipped oracles would have reported had they run. */
	suppressed: readonly ComposerOracleGuarantee[];
}

const records: Record_[] = [];

beforeAll(async () => {
	await initTheme(false);

	let counter = 0;
	for (const flavor of FLAVORS) {
		for (const width of WIDTHS) {
			for (const height of HEIGHTS) {
				for (const depth of DEPTHS) {
					for (const offset of OFFSETS) {
						for (const isolation of ISOLATION) {
							const focused = FOCUS[counter % FOCUS.length]!;
							const modeState = MODE_STATES[counter % MODE_STATES.length];
							counter += 1;

							const run = await runComposerOracleScenario({
								width,
								height,
								modeState,
								editorText: "run the build",
								transcriptLines: contentLines(flavor, depth),
								transcriptLineMarkers: [FLAVOR_MARK[flavor]],
								scrollIsolation: isolation,
								scrollOffset: offset,
								focused,
							});
							try {
								const state = run.frameState;
								const suppressed: ComposerOracleGuarantee[] = [];
								for (const id of run.evaluation.skipped) {
									if (COMPOSER_ORACLES[id].run(state) !== null) suppressed.push(id);
								}
								records.push({
									name: `${flavor}/${width}x${height}/d${depth}/off${offset}/iso${isolation}/focus${focused}`,
									depth,
									height,
									offset,
									frozen: state.virtualScrollTop !== null,
									skipped: run.evaluation.skipped,
									inspected: run.evaluation.inspected,
									blind: run.evaluation.blind,
									contentRowsOnScreen: Math.max(0, state.screenBounds.footerTop),
									padWithinVisibleTail: state.segments
										.filter(segment => segment.componentName === "CardPadRow" && segment.rowCount > 0)
										.every(segment => segment.startIndex >= state.totalFrameRows - height),
									suppressed,
								});
							} finally {
								run.cleanUp();
							}
						}
					}
				}
			}
		}
	}
}, 900_000);

/** Sorted unique ids, so a pin compares sets rather than iteration order. */
function ids(from: Iterable<ComposerOracleGuarantee>): ComposerOracleGuarantee[] {
	return [...new Set(from)].sort();
}

describe("the registry is total over its own guarantee list", () => {
	it("keys an oracle for every declared guarantee, and declares every key", () => {
		expect(ids(Object.keys(COMPOSER_ORACLES) as ComposerOracleGuarantee[])).toEqual(ids(COMPOSER_ORACLE_GUARANTEES));
		for (const id of COMPOSER_ORACLE_GUARANTEES) {
			expect(COMPOSER_ORACLES[id].id, `${id} is filed under the wrong key`).toBe(id);
			expect(COMPOSER_ORACLES[id].description.length, `${id} has no description`).toBeGreaterThan(20);
		}
	});

	it("drove the whole matrix", () => {
		expect(records.length).toBe(
			FLAVORS.length * WIDTHS.length * HEIGHTS.length * DEPTHS.length * OFFSETS.length * ISOLATION.length,
		);
	});

	it("accounts for every guarantee exactly once in every state", () => {
		const expected = ids(COMPOSER_ORACLE_GUARANTEES);
		const wrong: string[] = [];
		for (const record of records) {
			const all = [...record.skipped, ...record.inspected, ...record.blind];
			if (all.length !== expected.length) {
				wrong.push(`${record.name}: accounted ${all.length} of ${expected.length}`);
				continue;
			}
			const seen = ids(all);
			if (seen.join(",") !== expected.join(",")) wrong.push(`${record.name}: ${seen.join(",")}`);
		}
		expect(wrong).toEqual([]);
	});
});

describe("an oracle that never reads anything is a hole, not a pass", () => {
	it("inspects a non-empty subject for every guarantee somewhere in the matrix", () => {
		const everInspected = new Set<ComposerOracleGuarantee>();
		for (const record of records) for (const id of record.inspected) everInspected.add(id);
		const never = ids(COMPOSER_ORACLE_GUARANTEES).filter(id => !everInspected.has(id));
		expect(never).toEqual([]);
	});

	it("goes blind only for the guarantees whose subject a state can legitimately lack", () => {
		const everBlind = new Set<ComposerOracleGuarantee>();
		for (const record of records) for (const id of record.blind) everBlind.add(id);
		// A transcript-less state paints no transcript row, so the two bleed oracles have nothing to
		// read, and a terminal too short to hold the input card paints no padding row. Pinned by exact
		// equality: any other oracle going blind anywhere is the defect class this suite exists for,
		// and a new oracle that reads nothing lands here.
		expect(ids(everBlind)).toEqual([
			"composerCardPadsAreUnpaintedAir",
			"noMixedTranscriptAndChromeRows",
			"noOutputBleedPastComposer",
		]);
	});

	it("goes blind only where the geometry accounts for it", () => {
		// The flat pin above says which oracles may read nothing. This says when: a blind verdict has
		// to have a reason in the state that produced it. The padding oracle reading nothing on a tall
		// terminal was the original defect, and it is invisible to a pin that only lists names.
		const REASONS: Partial<Record<ComposerOracleGuarantee, (record: Record_) => boolean>> = {
			// No transcript rows were asked for, or the composer fills the terminal and leaves no screen
			// row above itself, so no transcript row was painted for either bleed oracle to match.
			noOutputBleedPastComposer: record => record.depth === 0 || record.contentRowsOnScreen === 0,
			noMixedTranscriptAndChromeRows: record => record.depth === 0 || record.contentRowsOnScreen === 0,
			// The padding rows are outside the band of frame rows the terminal shows, so there is no
			// screen row to read. A pad the ledger puts inside that band and the oracle still cannot
			// see is the original defect, and it is not excused here.
			composerCardPadsAreUnpaintedAir: record => !record.padWithinVisibleTail,
		};
		const unexplained: string[] = [];
		for (const record of records) {
			for (const id of record.blind) {
				const reason = REASONS[id];
				if (!reason?.(record)) unexplained.push(`${record.name}: ${id}`);
			}
		}
		expect(unexplained).toEqual([]);
	});

	it("reads every subject in a state whose transcript is deep and whose terminal is tall", () => {
		const holes: string[] = [];
		for (const record of records) {
			if (record.depth < 30 || record.height < 16 || record.offset !== 0) continue;
			if (record.blind.length > 0) holes.push(`${record.name}: ${ids(record.blind).join(",")}`);
		}
		expect(holes).toEqual([]);
	});
});

describe("a skip is a declaration, not a way out of a verdict", () => {
	it("skips nothing that would have reported a failure", () => {
		const hidden: string[] = [];
		for (const record of records) {
			if (record.suppressed.length > 0) hidden.push(`${record.name}: ${ids(record.suppressed).join(",")}`);
		}
		expect(hidden).toEqual([]);
	});

	it("declares the same guarantees out of scope for every frozen state", () => {
		const frozen = records.filter(r => r.frozen);
		expect(frozen.length).toBeGreaterThan(0);
		// `footerOccupiesBottomPhysicalRows` judged nothing while frozen before the registry: both of
		// its branches require a live tail, so it fell out of its own body reporting a pass. The
		// frozen-view guarantee is the one that covers this state, and it is inspected here.
		for (const record of frozen) {
			expect(record.skipped, `${record.name} stopped declaring the live-tail footer check`).toContain(
				"footerOccupiesBottomPhysicalRows",
			);
			expect(record.inspected, `${record.name} stopped judging the frozen footer`).toContain(
				"virtualScrollPreservesFooterStability",
			);
		}
	});

	it("declares the frozen-view guarantee out of scope on the live tail", () => {
		const live = records.filter(r => !r.frozen);
		expect(live.length).toBeGreaterThan(0);
		for (const record of live) {
			expect(record.skipped, `${record.name} judged a frozen footer on the live tail`).toContain(
				"virtualScrollPreservesFooterStability",
			);
		}
	});
});

describe("subjectSize counts what an oracle would read", () => {
	it("reports zero only for an empty collection", () => {
		expect(subjectSize({ kind: "rows", rows: [] })).toBe(0);
		expect(subjectSize({ kind: "rows", rows: [3] })).toBe(1);
		expect(subjectSize({ kind: "routing", rows: [] })).toBe(0);
		expect(subjectSize({ kind: "ledger", segments: [] })).toBe(0);
		expect(subjectSize({ kind: "cursor", row: 0, col: 0 })).toBe(1);
		expect(subjectSize({ kind: "bounds", footerTop: 0, footerBottom: 0 })).toBe(1);
	});
});
