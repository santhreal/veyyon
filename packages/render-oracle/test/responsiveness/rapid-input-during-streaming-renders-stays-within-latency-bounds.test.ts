/**
 * A keystroke typed during a heavy stream is drawn on the operator's schedule, not the stream's.
 *
 * WHY THIS SUITE EXISTS: adaptive backpressure holds the render loop near a 50% duty cycle by
 * pushing the next frame out by twice the measured frame cost, up to 200ms. It charged that
 * delay to every frame, including the one a keystroke asked for, and a frame already armed at
 * the long delay was never pulled earlier — so typing into the composer while a tool streamed
 * showed the character up to a fifth of a second after the key went down.
 *
 * WHAT IT CLOSES: an operator-caused frame paying a background loop's backpressure, in both
 * shapes — the delay computed for the keystroke's own frame, and the delay of a frame already
 * scheduled in front of it.
 *
 * WHAT IT DOES NOT CATCH: the cost of the keystroke's own frame. A composer whose render is slow
 * is slow whatever the scheduler does, and no delay measured here would show it.
 */

import { describe, expect, it } from "bun:test";
import { type FrameClock, ManualRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { Editor } from "@veyyon/tui/components/editor";
import { defaultEditorTheme } from "@veyyon/tui/test-support";
import { type Component, TUI } from "@veyyon/tui/tui";

/**
 * Token output whose render costs real time on the supplied clock, which is what the adaptive
 * floor is derived from. A stream that renders instantly cannot produce backpressure, and a test
 * built on one proves nothing about typing during a slow one.
 */
class StreamingSimulationComponent implements Component {
	/** Clock reading when the last paint began, before this render charged its own cost. */
	paintStartedAt = 0;
	#tokens: string[] = [];
	constructor(
		private readonly clock?: FrameClock,
		private readonly renderCostMs = 0,
	) {}

	invalidate(): void {}

	pushToken(token: string): void {
		this.#tokens.push(token);
	}

	render(_width: number): readonly string[] {
		if (this.clock) {
			this.paintStartedAt = this.clock.time;
			this.clock.time += this.renderCostMs;
		}
		const lines: string[] = [];
		for (let i = 0; i < Math.min(15, this.#tokens.length); i++) {
			lines.push(`Streaming output line ${i}: ${this.#tokens[i]}`);
		}
		return lines.length > 0 ? lines : ["Streaming waiting..."];
	}
}

describe("rapid input during streaming renders stays within latency bounds", () => {
	/** A TUI whose stream has been rendering slowly for long enough to raise the adaptive floor. */
	function underHeavyStream(frameCostMs: number): {
		term: VirtualTerminal;
		tui: TUI;
		scheduler: ManualRenderScheduler;
		stream: StreamingSimulationComponent;
		editor: Editor;
	} {
		const term = new VirtualTerminal(80, 24);
		const scheduler = new ManualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const stream = new StreamingSimulationComponent(scheduler, frameCostMs);
		tui.addChild(stream);
		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		for (let i = 0; i < 8; i++) {
			stream.pushToken(`heavy-token-${i}`);
			tui.requestRender();
			scheduler.runPending();
		}
		return { term, tui, scheduler, stream, editor };
	}

	it("is armed sooner than the frame the stream asks for in the same state", () => {
		const { term, tui, scheduler, stream } = underHeavyStream(100);

		stream.pushToken("one-more");
		tui.requestRender();
		const background = scheduler.pending();
		if (!background) throw new Error("the stream armed no frame");
		// The stream is being held back, so the comparison below has something to mean.
		expect(background.delayMs).toBeGreaterThan(0);

		term.sendInput("X");
		const forKeystroke = scheduler.pending();
		if (!forKeystroke) throw new Error("the keystroke armed no frame");

		expect(forKeystroke.delayMs).toBeLessThan(background.delayMs);
	});

	it("pulls a frame already armed at the backpressure delay forward, and cancels it", () => {
		const { term, tui, scheduler, stream } = underHeavyStream(100);

		stream.pushToken("one-more");
		tui.requestRender();
		const background = scheduler.pending();
		if (!background) throw new Error("the stream armed no frame");

		term.sendInput("X");

		expect(background.cancelled).toBe(true);
		const forKeystroke = scheduler.pending();
		if (!forKeystroke) throw new Error("the keystroke armed no frame");
		expect(forKeystroke).not.toBe(background);
		expect(forKeystroke.delayMs).toBeLessThan(background.delayMs);
	});

	/**
	 * Wait, on the scheduler's own clock, between the stream asking for a frame and that frame
	 * beginning to paint — with and without a keystroke arriving in between. Both arms run the
	 * same harness from the same state, so the difference is the keystroke and nothing else.
	 */
	function waitBeforePaint(typeAKey: boolean): { waitMs: number; painted: boolean } {
		const { term, tui, scheduler, stream } = underHeavyStream(100);
		stream.pushToken("one-more");
		tui.requestRender();
		const startedAt = scheduler.time;
		if (typeAKey) term.sendInput("X");
		scheduler.runPending();
		return {
			waitMs: stream.paintStartedAt - startedAt,
			painted: term.getViewport().some(row => row.includes("X")),
		};
	}

	it("paints the typed character sooner than the same frame paints with nothing typed", () => {
		const typed = waitBeforePaint(true);
		const untouched = waitBeforePaint(false);

		expect(typed.painted).toBe(true);
		expect(untouched.painted).toBe(false);
		expect(typed.waitMs).toBeLessThan(untouched.waitMs);
	});

	/**
	 * Delay the stream's next frame is armed at, one frame after the state both arms share. The
	 * frame in between is the keystroke's in one arm and the stream's own in the other; both cost
	 * the same and both leave the clock in the same place, so the two delays are comparable
	 * exactly.
	 */
	function delayAfterOneFrame(typeAKey: boolean): number {
		const { term, tui, scheduler, stream } = underHeavyStream(100);
		stream.pushToken("one-more");
		tui.requestRender();
		if (typeAKey) term.sendInput("X");
		scheduler.runPending();

		stream.pushToken("and-another");
		tui.requestRender();
		const next = scheduler.pending();
		if (!next) throw new Error("the stream armed no frame");
		return next.delayMs;
	}

	it("charges the stream its backpressure again once the keystroke's frame has painted", () => {
		expect(delayAfterOneFrame(true)).toBe(delayAfterOneFrame(false));
	});

	it("loses no keystroke of a burst typed into a heavy stream, and needs no frame per stream token", () => {
		const { term, tui, scheduler, stream, editor } = underHeavyStream(100);
		const burstKeys = "abcdefghijklmnopqrst";

		for (let i = 0; i < burstKeys.length; i++) {
			stream.pushToken(`tok-${i}`);
			tui.requestRender();
			term.sendInput(burstKeys[i]!);
		}
		const framesRun = scheduler.drainFrames(burstKeys.length * 4);

		expect(editor.getText()).toBe(burstKeys);
		expect(term.getViewport().join("\n")).toContain(burstKeys);
		// Every keystroke is drawn, and the interleaved stream requests coalesce into the frames
		// the keystrokes already asked for rather than each buying one of its own.
		expect(framesRun).toBeLessThanOrEqual(burstKeys.length);
	});
});
