/**
 * A frame the engine took a shortcut on paints what a full compose would.
 *
 * THE DEFECT CLASS. Two shortcuts skip work a full compose does, and both
 * decide the frame's geometry from state they did not re-derive:
 *
 *   - A component-scoped frame (`requestComponentRender`) re-renders only the
 *     root subtrees that asked for it and reuses the previous segment of every
 *     other root. A requester whose OWN height changed moves every sibling
 *     below it, so a scoped frame that reuses stale offsets, or reports the old
 *     frame length, paints siblings at the wrong row. `composedFrameRows` is
 *     read by the home anchor to size the rows between the content and the
 *     composer, so a wrong length there is a composer on the wrong row.
 *   - A coalesced frame. Requests arriving faster than the adaptive floor are
 *     merged, so the state the terminal never saw has to be carried forward by
 *     the diff rather than repainted. A dropped intermediate that leaves a row
 *     behind is a tear that persists until something forces a full paint.
 *
 * THE ORACLE. Neither shortcut is asserted against a hand-written expectation,
 * because a hand-written one only proves the shortcut agrees with whatever the
 * author believed. Each is compared byte for byte against a SECOND TUI that
 * composed the same final state cold, in one frame, with no shortcut available
 * to it. Cold compose is the definition of correct here, so a shortcut that
 * differs from it in any cell fails, whatever the difference is.
 *
 * WHAT IT DOES NOT CATCH. Any ONE of the compose guards on its own. The engine
 * carries several that repair each other: dropping the row-count comparison
 * that breaks the stable chain leaves the frame-length comparison to force the
 * re-ingest, and dropping that one leaves the row-count comparison to have
 * already broken the chain. Removing BOTH is still invisible here. What the
 * oracle does catch is a shortcut that reaches the terminal wrong — reusing the
 * requester's own stale rows fails 3 of 5 arms, and an off-by-one stable prefix
 * fails 1 — so the guarantee is asserted end to end and not attributed to any
 * single line.
 *
 * Cost is also out of scope. A shortcut that produces the right bytes by
 * quietly doing the full work passes here and is a performance regression;
 * `packages/tui/bench/frame.bench.ts` is what measures that. So is timing:
 * `adaptive-render-backpressure.test.ts` owns when the next frame may start,
 * and this suite owns what it contains.
 */
import { describe, expect, it } from "bun:test";
import { StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, type RenderStablePrefix, TUI } from "@veyyon/tui";

const COLUMNS = 40;
const ROWS = 12;

/** A ref-stable root whose height the test changes, the way live content does. */
class Block implements Component {
	renders = 0;
	#lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	set(lines: readonly string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders++;
		return this.#lines;
	}
}

/**
 * A transcript-shaped root: it appends and truncates in place and reports how
 * many leading rows the engine may keep. Reference equality cannot see that,
 * so the report is the only thing standing between a grown root and a frame
 * that reuses rows the growth displaced.
 */
class InPlaceBlock implements Component, RenderStablePrefix {
	renders = 0;
	readonly lines: string[];
	#stable = 0;

	constructor(lines: readonly string[]) {
		this.lines = [...lines];
		this.#stable = lines.length;
	}

	/** Keep the first `keep` rows verbatim and rewrite the rest to `total` rows. */
	reshape(total: number, keep: number): void {
		this.#stable = Math.min(keep, total, this.lines.length);
		this.lines.length = Math.min(this.lines.length, total);
		for (let i = this.#stable; i < total; i++) this.lines[i] = `body-${i + 1}-v${total}`;
	}

	getRenderStablePrefixRows(): number {
		return this.#stable;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders++;
		return this.lines;
	}
}

function strip(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

interface Painted {
	viewport: string[];
	frameRows: number;
}

/**
 * The oracle: one TUI, one frame, no shortcut. Every shortcut path is compared
 * against what this paints for the same children.
 */
async function coldCompose(states: readonly (readonly string[])[]): Promise<Painted> {
	const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	for (const lines of states) tui.addChild(new Block(lines));
	try {
		tui.start();
		await scheduler.drain(term);
		tui.requestRender();
		await scheduler.drain(term);
		return { viewport: strip(term.getViewport()), frameRows: tui.composedFrameRows };
	} finally {
		tui.stop();
		await term.flush();
	}
}

/** Heights a scoped requester can move to: shorter, same, taller, and taller again. */
const SCOPED_HEIGHT_STEPS: readonly number[] = [1, 2, 2, 5, 3, 1, 4];

/** `[total rows, rows the root reports stable]` after an in-place reshape. */
const SCOPED_RESHAPES: ReadonlyArray<readonly [number, number]> = [
	[5, 2],
	[2, 2],
	[6, 2],
	[3, 3],
	[7, 7],
	[2, 2],
	[4, 4],
];

function rowsOf(label: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${label}-${i + 1}`);
}

describe("a component-scoped frame sizes itself from the children it did not re-render", () => {
	it("matches a cold compose at every height the requester moves to", async () => {
		const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const head = new Block(rowsOf("head", 2));
		const live = new Block(rowsOf("live", 1));
		const tail = new Block(rowsOf("tail", 2));
		tui.addChild(head);
		tui.addChild(live);
		tui.addChild(tail);

		const divergences: Array<{ height: number; scoped: Painted; cold: Painted }> = [];
		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			for (const height of SCOPED_HEIGHT_STEPS) {
				live.set(rowsOf("live", height));
				// The scoped path is the whole subject: a full request here would
				// make every arm below a plain compose and prove nothing.
				const siblingRendersBefore = head.renders + tail.renders;
				tui.requestComponentRender(live);
				await scheduler.drain(term);

				const scoped: Painted = { viewport: strip(term.getViewport()), frameRows: tui.composedFrameRows };
				const cold = await coldCompose([rowsOf("head", 2), rowsOf("live", height), rowsOf("tail", 2)]);
				// Non-vacuity: if the engine downgraded to a full compose, the
				// siblings re-rendered and this arm is comparing a full compose
				// against a full compose.
				expect({ height, reRendered: head.renders + tail.renders - siblingRendersBefore }).toEqual({
					height,
					reRendered: 0,
				});
				if (scoped.viewport.join("\n") !== cold.viewport.join("\n") || scoped.frameRows !== cold.frameRows) {
					divergences.push({ height, scoped, cold });
				}
			}
		} finally {
			tui.stop();
			await term.flush();
		}

		expect(divergences).toEqual([]);
		// Non-vacuity: the sweep really moved the requester's height around.
		expect(SCOPED_HEIGHT_STEPS.length).toBeGreaterThan(4);
	});

	it("re-ingests below a root that grew in place and only reported its stable prefix", async () => {
		// Reference equality cannot see an in-place mutation, so the engine
		// trusts the root's stable-prefix report. A report that survives a row
		// count change lets the frame keep rows the growth displaced, and the
		// sibling below is painted over its own old rows.
		const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const body = new InPlaceBlock(rowsOf("body", 3));
		const footer = new Block(["footer-1", "footer-2"]);
		tui.addChild(body);
		tui.addChild(footer);

		const divergences: Array<{ total: number; got: string[]; want: string[]; frameRows: number }> = [];
		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			// Two report policies, because they reach different guards. Keeping a
			// fixed prefix reports LESS than the new row count; keeping the whole
			// body reports all of it while the count still moved, which is the
			// only shape that reaches the row-count comparison.
			for (const [total, keep] of SCOPED_RESHAPES) {
				body.reshape(total, keep);
				tui.requestComponentRender(body);
				await scheduler.drain(term);

				const want = [...body.lines, "footer-1", "footer-2"];
				const got = strip(term.getViewport()).filter(row => row.length > 0);
				if (got.join("\n") !== want.join("\n") || tui.composedFrameRows !== want.length) {
					divergences.push({ total, got, want, frameRows: tui.composedFrameRows });
				}
			}
		} finally {
			tui.stop();
			await term.flush();
		}

		expect(divergences).toEqual([]);
	});

	it("reports the frame length the anchor needs after the requester grew", async () => {
		// The single number the home anchor reads. Asserted on its own, because
		// a viewport that happens to match says nothing about a frame taller
		// than the window, which is exactly where the anchor uses it.
		const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const live = new Block(rowsOf("live", 1));
		const tail = new Block(rowsOf("tail", 3));
		tui.addChild(live);
		tui.addChild(tail);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);
			expect(tui.composedFrameRows).toBe(4);

			live.set(rowsOf("live", 6));
			tui.requestComponentRender(live);
			await scheduler.drain(term);

			expect(tui.composedFrameRows).toBe(9);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("a frame the loop coalesced leaves the viewport a cold compose would paint", () => {
	it("carries every skipped intermediate forward", async () => {
		const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const block = new Block(rowsOf("step", 1));
		tui.addChild(block);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			// Eight states, one drain: the loop composes far fewer than eight
			// frames, so most of these are never painted at all.
			const rendersBefore = block.renders;
			for (const height of [3, 7, 2, 9, 4, 1, 6, 2]) {
				block.set(rowsOf("step", height));
				tui.requestRender();
			}
			await scheduler.drain(term);
			expect(block.renders - rendersBefore).toBeLessThan(8);

			const coalesced = strip(term.getViewport());
			const cold = await coldCompose([rowsOf("step", 2)]);
			expect(coalesced).toEqual(cold.viewport);
			expect(tui.composedFrameRows).toBe(cold.frameRows);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("carries a shrink forward without leaving the taller state behind", async () => {
		// The direction that tears: a dropped intermediate that was TALLER than
		// the state that landed leaves its extra rows painted with nothing to
		// overwrite them.
		const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const block = new Block(rowsOf("wide", 8));
		tui.addChild(block);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			for (const height of [9, 10, 2]) {
				block.set(rowsOf("wide", height));
				tui.requestRender();
			}
			await scheduler.drain(term);

			const cold = await coldCompose([rowsOf("wide", 2)]);
			expect(strip(term.getViewport())).toEqual(cold.viewport);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
