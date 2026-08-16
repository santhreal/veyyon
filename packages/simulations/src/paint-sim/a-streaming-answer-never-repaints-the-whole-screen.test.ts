/**
 * A streaming answer costs differential updates, never a whole-screen repaint.
 *
 * WHAT THIS CLOSES. The engine repairs a committed-prefix divergence by
 * repainting the window, and with `tui.scrollbackRebuild` on (the shipped
 * default) by erasing native scrollback first and replaying the transcript.
 * That repair is correct for a real divergence and catastrophic as a steady
 * state: at a few frames per second it reads as the screen tearing, and at
 * sixty it is a strobe. Two ways of provoking it as a steady state have now
 * shipped. The virtualized transcript dropped rows the engine had committed
 * and the engine kept the pre-splice coordinates, so every later frame
 * diverged; and once that was fixed for a transcript at frame row 0, the slide
 * still assumed the transcript IS at row 0, so the shipped layout — which
 * always mounts a filler above it, and hangs the todo and subagent HUDs in the
 * same band — diverged by exactly the header height instead.
 *
 * THE CLASS, not the incident. The invariant is that where the dropping child
 * sits among its siblings, and how tall its neighbours are, cannot change
 * whether an ordinary frame is destructive. So the sweep drives identical
 * traffic across header heights, HUD heights, footer heights, viewport heights
 * and both settings of the rebuild knob, and in every one of them pins erases
 * to zero and whole-screen repaints to the number of frames the scenario
 * itself made SHORTER — a frame that shrinks has to move every row on screen,
 * so it costs one bounded in-place rewrite, and a repaint on any other frame
 * is the defect.
 *
 * WHAT IT DOES NOT CATCH. It measures composition, not cadence: a repaint
 * SOURCE that asks for sixty frames a second (an animation that never settles)
 * makes each of these frames cheap and the screen still unusable, which is
 * `packages/tui/test/the-motion-clock-always-stops.test.ts`. It drives one
 * width, no images, no alternate screen, and no multiplexer pane, where the
 * divergence rebuild is gated off entirely and the repair contract differs.
 */
import { describe, expect, test } from "bun:test";
import { label, type PaintShape, paintSim, shapes } from "./harness";

const BASE: PaintShape = {
	width: 100,
	height: 40,
	headerRows: 2,
	hudRows: 0,
	footerRows: 1,
	turns: 30,
	streamFrames: 40,
	scrollbackRebuild: true,
	virtualized: true,
};

const CASE_TIMEOUT_MS = 60_000;

describe("a streaming answer never repaints the whole screen", () => {
	// Derived from the shape fields rather than written out, so a new value of
	// any of them is a one-line change and every combination of it is covered.
	const sweep = shapes(BASE, {
		headerRows: [0, 1, 2, 5],
		hudRows: [0, 3],
		footerRows: [1, 3],
		height: [40, 24],
		scrollbackRebuild: [1, 0],
	}).map(shape => ({ ...shape, scrollbackRebuild: Boolean(shape.scrollbackRebuild) }));

	for (const shape of sweep) {
		test(
			label(shape),
			async () => {
				const report = await paintSim(shape);

				// The two numbers a reader would call a broken screen: an erased
				// native scrollback, and history that stopped being in it.
				expect({ erases: report.erases, lost: report.lostTurns }).toEqual({ erases: 0, lost: [] });
				// A frame that gets SHORTER has to move every row on screen, so it
				// costs one in-place rewrite of the window — bounded, non
				// destructive, and nothing enters or leaves scrollback. Every other
				// frame must be a differential update. The count is pinned to the
				// shrinks the scenario itself performed, so an extra repaint on a
				// frame that only grew is red, which is exactly the defect: a
				// streamed row that repainted the screen.
				expect({ arm: label(shape), redraws: report.fullRedraws }).toEqual({
					arm: label(shape),
					redraws: report.hudShrinks,
				});
			},
			CASE_TIMEOUT_MS,
		);
	}

	test(
		"a plain container is the control: no drops, no repaints",
		async () => {
			const report = await paintSim({ ...BASE, virtualized: false });

			expect({ redraws: report.fullRedraws, erases: report.erases }).toEqual({ redraws: 0, erases: 0 });
			expect(report.lostTurns).toEqual([]);
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"the rebuild knob changes nothing while nothing diverges",
		async () => {
			// Exact parity: the setting decides how a GENUINE divergence is
			// repaired. A session that never diverges must not be able to tell
			// which way it is set, and a difference here means something is
			// diverging that this suite is about to stop noticing.
			const on = await paintSim({ ...BASE, scrollbackRebuild: true });
			const off = await paintSim({ ...BASE, scrollbackRebuild: false });

			expect(on.bytes).toBe(off.bytes);
			expect(on.scrollTapeRows).toBe(off.scrollTapeRows);
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"a frame writes a screenful at most, so no frame can be a hidden replay",
		async () => {
			// A whole-screen repaint that somehow did not increment the counter is
			// still visible in the bytes: a replay of a long transcript is orders
			// of magnitude wider than the row that changed. The bound is generous
			// (a full window plus its escapes) and still an order of magnitude
			// below the 5 KB/frame replays the defect produced at this shape.
			const report = await paintSim(BASE);
			const budget = BASE.width * BASE.height;
			const worst = Math.max(...report.frames.map(frame => frame.bytes));

			expect(report.frames.length).toBe(BASE.streamFrames);
			expect(worst).toBeLessThan(budget);
		},
		CASE_TIMEOUT_MS,
	);
});
