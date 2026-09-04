/**
 * A turn that ends short leaves the conversation on screen.
 *
 * THE DEFECT. A session that had scrolled, whose last frame was SHORTER than the
 * viewport, painted a screen-sized band of blank rows over the conversation and
 * left a stray fence and rule floating above the HUD. Two components are on the
 * path and it matters which one was wrong:
 *
 *  1. `TranscriptContainer` compacted EVERY committed row out of the frame. The
 *     engine re-shows committed rows when a frame shrinks below the viewport
 *     ("duplication, never loss") and can only re-show rows the frame still
 *     contains, so with them gone it had nothing to fill the screen with. That is
 *     the defect: the frame lied about how long the session was.
 *  2. `HomeAnchorLayout.sync` read that short frame and routed the difference
 *     into `topFill`, which is what put blank rows ON the history. The anchor is
 *     downstream and correct — its slack is only ever empty room because a frame
 *     is never shorter than its window. Guarding it instead (route nothing once
 *     anything has scrolled) was measured on this harness and fixes nothing: the
 *     same band moves BELOW the composer and strands it 18 rows off the bottom
 *     edge, which is why both signs are pinned below.
 *
 * THE CLASS. Not "the answer collapsed": any end-of-turn event that leaves the
 * frame shorter than the viewport in a session that has scrolled. `SHRINKS`
 * enumerates them and every arm here sweeps all of them, so a new one has to be
 * named in that table (pinned below by exact equality) before this suite will
 * run at all.
 *
 * THE RULE, in two halves that only make sense together:
 *  - Once history exists to fill the screen, a blank band is a defect, and the
 *    bound is the blank run of the history that already scrolled off — measured
 *    from what was painted, so no constant can be tuned to accept a void.
 *  - Before anything has scrolled, the anchor's fill is the FEATURE (a young
 *    conversation hugs the composer at the bottom), so a suite that only banned
 *    blank rows would be satisfied by deleting the anchor. The young-session arms
 *    require the fill to still be there.
 *
 * WHAT IT DOES NOT CATCH, all of it measured rather than assumed. The band is
 * read off the settled screen, so a transient void that appears and repairs
 * inside one settle is invisible here; `shrinkRedraws` bounds the repaint such a
 * repair would cost, which is the only signature it leaves. A frame that grows
 * (the terminal is resized taller) is out of scope for this family, whose charter
 * forbids wall-clock sleeps while the resize path defers its authoritative replay
 * past a real 120ms settle — `SHRINKS` says so where it is declared. Inside
 * `#compactCommittedPrefix` neither branch is distinguishable by any arm, and both
 * were measured: dropping past the retain floor makes the separator trim's row
 * count negative, which cancels the whole drop, so such a frame is byte-identical
 * to a correct one (five arms, identical numbers); and over-trimming the
 * separator is bounded by one row, which every arm's frame clears the window by.
 * What IS gated is the floor itself — its value, and being fed before the render
 * that drops the rows. Nothing here speaks about the scrollback of a terminal
 * that erases it — `lostTurns` is the streaming suite's question.
 */
import { describe, expect, test } from "bun:test";
import { label, type PaintShape, paintSim, SHRINKS, type ShrinkKind, shapes } from "./harness";

const CASE_TIMEOUT_MS = 60_000;

/**
 * A session long enough to have scrolled: 24 turns of four rows against a
 * viewport of at most 40, with the HUD band and pinned footer the shipped screen
 * carries.
 */
const SCROLLED: PaintShape = {
	width: 100,
	height: 30,
	headerRows: 2,
	hudRows: 5,
	footerRows: 2,
	turns: 24,
	streamFrames: 20,
	scrollbackRebuild: true,
	virtualized: true,
	homeAnchor: true,
	shrink: "none",
};

/**
 * What the SHRINK frame alone may cost. The discriminator is whether HISTORY
 * changed, not whether the screen moved:
 *
 *  - A frame that only got shorter has to move every row it still shows, so it
 *    costs one whole-screen rewrite — and zero erases. Native scrollback still
 *    holds exactly what was painted, so erasing it would be destroying history
 *    to repair nothing, which is the flash.
 *  - The settled answer is the one case where history really did change: rows
 *    that already scrolled off are replaced, so the engine erases and replays to
 *    leave the block in scrollback exactly once ("duplication, never loss").
 *
 * One repair per event, never one per frame — a strobe is what these bounds
 * exclude, and the stream window is pinned separately so a repaint cannot hide
 * there instead.
 */
const SHRINK_BUDGET: Record<ShrinkKind, { redraws: number; erases: number }> = {
	none: { redraws: 0, erases: 0 },
	"answer-collapse": { redraws: 1, erases: 1 },
	"hud-collapse": { redraws: 1, erases: 0 },
};

describe("a turn that ends short never paints a blank band over the conversation", () => {
	test("the shrink kinds this suite claims to cover are the shipped ones", () => {
		// Fail-by-default: a new member of the union is a decision somebody has to
		// record here, and until they do, every arm below is missing it.
		expect([...SHRINKS]).toEqual(["none", "answer-collapse", "hud-collapse"]);
		expect(Object.keys(SHRINK_BUDGET).sort()).toEqual([...SHRINKS].sort());
	});

	// Two viewport heights and both transcript kinds, so the claim is not a
	// property of one geometry or of virtualization alone. The LEAN frame is the
	// arm that makes the bound honest: with no header, no HUD and a one-row
	// footer, retained history is the only thing that can fill the window, so a
	// retention floor smaller than a viewport shows up here and nowhere else
	// (measured: half a viewport leaves a 5-row band on the 24-row lean arm and
	// none of the HUD-carrying arms).
	const LEAN: PaintShape = { ...SCROLLED, headerRows: 0, hudRows: 0, footerRows: 1 };
	const arms = [SCROLLED, LEAN].flatMap(base =>
		shapes(base, { height: [24, 40], virtualized: [1, 0] }).flatMap(shape =>
			SHRINKS.map(shrink => ({ ...shape, virtualized: Boolean(shape.virtualized), shrink })),
		),
	);

	for (const shape of arms) {
		test(
			label(shape),
			async () => {
				const report = await paintSim(shape);

				// The session must actually have scrolled, or the arm is asking its
				// question of a screen that never had history to lose.
				expect(report.scrollTapeRows).toBeGreaterThan(0);

				// The band, against the blank run the painted history itself carries
				// (block separators are one row, so the floor is 1).
				const bound = Math.max(1, report.contentBlankRun);
				expect({
					arm: label(shape),
					bandOverBound: report.blankBand > bound,
					conversationOnScreen: report.historyRowsOnScreen > 0,
				}).toEqual({ arm: label(shape), bandOverBound: false, conversationOnScreen: true });

				// The stream itself. An erase mid-turn is the strobe and is banned
				// outright; a whole-screen rewrite is allowed only for a frame the
				// script itself made shorter (the HUD appearing and going), counted
				// from the script so the engine is not being compared to itself.
				const stream = report.frames.reduce(
					(sum, frame) => ({ redraws: sum.redraws + frame.fullRedraws, erases: sum.erases + frame.erases }),
					{ redraws: 0, erases: 0 },
				);
				expect({
					arm: label(shape),
					erases: stream.erases,
					redrawsOverShrinks: stream.redraws > report.hudShrinks,
				}).toEqual({ arm: label(shape), erases: 0, redrawsOverShrinks: false });
				// The shrink frame, against the budget its event is allowed.
				const budget = SHRINK_BUDGET[shape.shrink];
				expect({
					arm: label(shape),
					redrawsOverBudget: report.shrinkRedraws > budget.redraws,
					erasesOverBudget: report.shrinkErases > budget.erases,
				}).toEqual({ arm: label(shape), redrawsOverBudget: false, erasesOverBudget: false });

				// Nothing above the transcript may be filler once history is there.
				expect({ arm: label(shape), topFill: report.topFillRows }).toEqual({ arm: label(shape), topFill: 0 });

				// And the band cannot escape downwards instead. A frame shorter than
				// the window with nothing above it to fill leaves the composer
				// stranded mid-screen with the blanks under it — the same defect
				// wearing the opposite sign, and the state a fix that only deletes
				// the filler produces (measured: composer on row 21 of 40).
				const lastPainted = report.viewport.reduce((last, row, i) => (row.trim().length > 0 ? i : last), -1);
				expect({ arm: label(shape), lastPainted, bottom: report.viewport.length - 1 }).toEqual({
					arm: label(shape),
					lastPainted: report.viewport.length - 1,
					bottom: report.viewport.length - 1,
				});
			},
			CASE_TIMEOUT_MS,
		);
	}

	// The other half of the rule. Deleting the anchor would satisfy every arm
	// above; these arms fail if it is gone.
	const young: PaintShape = { ...SCROLLED, turns: 1, streamFrames: 0, hudRows: 0, headerRows: 0 };

	for (const shrink of SHRINKS) {
		test(
			`a young conversation still hugs the composer to the bottom (shrink=${shrink})`,
			async () => {
				const report = await paintSim({ ...young, shrink });

				// Nothing has scrolled: the screen is not full, so the fill is what
				// puts the conversation on the bottom edge, and it must be there.
				expect(report.scrollTapeRows).toBe(0);
				expect(report.topFillRows).toBeGreaterThan(0);
				// The composer is the last thing on screen, on the bottom row.
				const lastPainted = report.viewport.reduce((last, row, i) => (row.trim().length > 0 ? i : last), -1);
				expect({ shrink, lastPainted, height: report.viewport.length - 1 }).toEqual({
					shrink,
					lastPainted: report.viewport.length - 1,
					height: report.viewport.length - 1,
				});
			},
			CASE_TIMEOUT_MS,
		);
	}
});
