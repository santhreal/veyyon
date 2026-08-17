// SCRATCH PROBE: with DEFAULT settings (tui.scrollIsolation off), does an
// overlay that is playing itself out turn every subsequent frame into a
// full-viewport repaint?
//
// Branch-new: `#isOverlayVisible` (tui.ts:2143) now answers true for an entry
// marked `exiting` (tui.ts:2103/2156). `hasVisibleOverlay` (tui.ts:3867) is read
// from it, which freezes commits (tui.ts:3968) and sets
// `repaintVirtualScrollInPlace` (tui.ts:4143) -> `inPlaceRewrite` (tui.ts:5015)
// -> `#fullRedrawCount += 1` and a whole-window rewrite (tui.ts:5017-5041) on
// EVERY frame. If the component never calls `done`, the entry never leaves the
// stack and that never stops.

import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "../packages/tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../packages/tui/test/virtual-terminal";

class Transcript implements Component {
	lines: string[] = [];
	invalidate(): void {}
	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class Loader implements Component {
	frame = 0;
	invalidate(): void {}
	render(_width: number): readonly string[] {
		return [`${"ABCD"[this.frame % 4]} working`];
	}
}

/** A card that takes the exit callbacks and never finishes. */
class FadingCard implements Component {
	done: (() => void) | null = null;
	invalidate(): void {}
	beginOverlayExit(_requestRender: () => void, done: () => void): boolean {
		this.done = done;
		return true;
	}
	render(_width: number): readonly string[] {
		return ["card"];
	}
}

describe("exiting overlay repaint probe", () => {
	it("counts full redraws per frame while a card is playing itself out", async () => {
		const term = new VirtualTerminal(40, 10, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const transcript = new Transcript();
		const loader = new Loader();
		tui.addChild(transcript);
		tui.addChild(loader);
		transcript.lines = Array.from({ length: 30 }, (_, i) => `hist-${String(i).padStart(3, "0")}`);
		tui.start();
		await scheduler.drain(term);

		try {
			// Control: ten spinner ticks with no overlay in the stack.
			let before = tui.fullRedraws;
			for (let i = 0; i < 10; i++) {
				loader.frame += 1;
				tui.requestRender();
				await scheduler.drain(term);
			}
			const control = tui.fullRedraws - before;

			const card = new FadingCard();
			const handle = tui.showOverlay(card);
			await scheduler.drain(term);
			handle.hide(); // begins the exit; `done` is never called
			await scheduler.drain(term);
			expect(tui.hasOverlay()).toBe(false); // non-interactive, still painted

			before = tui.fullRedraws;
			for (let i = 0; i < 10; i++) {
				loader.frame += 1;
				tui.requestRender();
				await scheduler.drain(term);
			}
			const fading = tui.fullRedraws - before;

			console.log(`full redraws over 10 frames: control=${control} while-exiting=${fading}`);
			expect(control).toBe(0);
			expect(fading).toBe(10);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
