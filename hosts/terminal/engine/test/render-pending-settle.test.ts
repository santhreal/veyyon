/**
 * `TUI.renderPending` and the shared `settleFrames` helper it exists for.
 *
 * Integration suites need one honest answer to "has the engine finished
 * painting". They used to guess two ways, and both ways produced flakes that
 * only appeared in a loaded full sweep and read exactly like regressions:
 *
 *  - `await Bun.sleep(40)`: a bet that the throttled frame lands in 40 ms.
 *    `overlay-scroll` read `"status-before"` one frame after setting the text to
 *    `"status-after"`.
 *  - sampling diagnostic counters until two samples matched: indistinguishable
 *    from an engine that has not started, since nothing has changed yet. The
 *    pinned-composer suite froze a view that three still-queued wheel events
 *    then moved.
 *
 * These tests pin the signal (`renderPending` is true exactly while a frame is
 * owed) and the helper's guarantee (it never returns while one is owed, however
 * late the frame is scheduled), including the case the 40 ms sleep got wrong.
 */
import { describe, expect, it } from "bun:test";
import { type Component, type RenderScheduler, type RenderTimer, TUI } from "@veyyon/tui";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

/** A component whose rows the test rewrites between frames. */
class Rows implements Component {
	constructor(private lines: string[]) {}
	setLines(lines: string[]): void {
		this.lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}

/** Requests another render from inside its own render, forever. */
class NeverQuiet implements Component {
	constructor(private readonly tui: () => TUI) {}
	invalidate(): void {}
	render(): string[] {
		this.tui().requestRender();
		return ["busy"];
	}
}

/**
 * The real scheduler with every frame pushed out by a fixed real delay.
 *
 * Not a fake clock: the point is a frame that genuinely arrives later than a
 * fixed sleep would wait for, which is what a loaded machine does to the 30 Hz
 * throttle.
 */
class SlowRenderScheduler implements RenderScheduler {
	constructor(private readonly delayMs: number) {}
	now(): number {
		return performance.now();
	}
	scheduleImmediate(callback: () => void): void {
		setTimeout(callback, this.delayMs);
	}
	scheduleRender(callback: () => void): RenderTimer {
		const timer = setTimeout(callback, this.delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	}
}

function plain(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("TUI.renderPending", () => {
	/** A TUI that has never been asked to paint owes nothing. Without this the
	 *  getter could be a constant `true` and every test below would still pass by
	 *  timing out into the same place. */
	it("is false on a fresh, unstarted TUI", () => {
		const tui = new TUI(new VirtualTerminal(20, 4));

		expect(tui.renderPending).toBe(false);
	});

	/** THE signal. `requestRender()` returns before the frame exists, so the
	 *  pending flag must be observable synchronously — that is the exact window
	 *  the counter-sampling settle used to mistake for quiescence. */
	it("is true synchronously after requestRender, before the frame is painted", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term, undefined, { renderScheduler: new SlowRenderScheduler(60) });
		const rows = new Rows(["one"]);
		tui.addChild(rows);
		try {
			tui.start();
			await settleFrames(term, tui);
			expect(tui.renderPending).toBe(false);

			rows.setLines(["two"]);
			tui.requestRender();

			expect(tui.renderPending).toBe(true);
			// And the frame really had not landed yet, so the flag is not merely
			// true-in-passing after the paint.
			expect(plain(term)[0]).toBe("one");

			await settleFrames(term, tui);
			expect(tui.renderPending).toBe(false);
			expect(plain(term)[0]).toBe("two");
		} finally {
			tui.stop();
		}
	});

	/** Stopping the engine must not leave the flag stuck true, or every settle in
	 *  a suite's teardown would time out instead of returning. */
	it("is false after stop, even with a frame requested", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term, undefined, { renderScheduler: new SlowRenderScheduler(60) });
		tui.addChild(new Rows(["one"]));
		tui.start();
		await settleFrames(term, tui);
		tui.requestRender();
		expect(tui.renderPending).toBe(true);

		tui.stop();

		expect(tui.renderPending).toBe(false);
	});
});

describe("settleFrames", () => {
	/**
	 * The regression the helper exists for, stated as a comparison: a 40 ms sleep
	 * is provably not enough for a frame scheduled 120 ms out, and `settleFrames`
	 * waits for it. This is what failed in the sweep — the assertion ran against
	 * the previous frame's bytes.
	 */
	it("waits for a frame the old fixed 40ms sleep would have missed", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term, undefined, { renderScheduler: new SlowRenderScheduler(120) });
		const rows = new Rows(["status-before"]);
		tui.addChild(rows);
		try {
			tui.start();
			await settleFrames(term, tui, { timeoutMs: 10_000 });
			expect(plain(term)[0]).toBe("status-before");

			rows.setLines(["status-after"]);
			tui.requestRender();

			// What the old helper did, and what it saw: the stale row.
			await new Promise<void>(resolve => process.nextTick(resolve));
			await Bun.sleep(40);
			await term.flush();
			expect(plain(term)[0]).toBe("status-before");

			await settleFrames(term, tui, { timeoutMs: 10_000 });
			expect(plain(term)[0]).toBe("status-after");
		} finally {
			tui.stop();
		}
	});

	/** Every queued change is on screen when it returns, not just the first: a
	 *  frame that lands during the settle may queue a follow-up, which is why the
	 *  helper requires the state to hold still after the engine reports idle. */
	it("returns only once the last of several queued updates is painted", async () => {
		const term = new VirtualTerminal(24, 4);
		const tui = new TUI(term, undefined, { renderScheduler: new SlowRenderScheduler(30) });
		const rows = new Rows(["r0"]);
		tui.addChild(rows);
		try {
			tui.start();
			await settleFrames(term, tui, { timeoutMs: 10_000 });

			for (let i = 1; i <= 5; i++) {
				rows.setLines([`r${i}`]);
				tui.requestRender();
			}
			await settleFrames(term, tui, { timeoutMs: 10_000 });

			expect(plain(term)[0]).toBe("r5");
			expect(tui.renderPending).toBe(false);
		} finally {
			tui.stop();
		}
	});

	/**
	 * An engine that never stops asking for frames is a defect, so the helper
	 * throws with the state it last saw rather than returning quietly. A silent
	 * return would surface later as an unrelated assertion failure, which is the
	 * failure mode this whole change is about.
	 */
	it("throws a diagnostic instead of returning when frames never stop", async () => {
		const term = new VirtualTerminal(20, 4);
		let tui: TUI | undefined;
		tui = new TUI(term, undefined, { renderScheduler: new SlowRenderScheduler(1) });
		tui.addChild(new NeverQuiet(() => tui as TUI));
		try {
			tui.start();

			await expect(settleFrames(term, tui, { timeoutMs: 300 })).rejects.toThrow(
				/settleFrames: the TUI never settled within 300ms \(last state /,
			);
		} finally {
			tui.stop();
		}
	});
});
