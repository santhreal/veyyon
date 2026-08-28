import { describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	constructor(private readonly events: string[]) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.events.push("input");
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): RenderTimer {
		const timer = { callback, canceled: false };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

function flushTimers(scheduler: DeferredRenderScheduler): void {
	const pending = scheduler.timers.splice(0, scheduler.timers.length);
	for (const timer of pending) if (!timer.canceled) timer.callback();
}

describe("TUI input/render scheduling", () => {
	it("can process terminal input before a deferred ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			// Fire every queued timer, not just the first: the engine also arms a mouse-grab
			// idle backstop at startup, and this test is about input-vs-repaint ORDER, not
			// about how many timers the engine happens to keep.
			flushTimers(scheduler);
			events.length = 0;
			scheduler.nowMs = 100;

			tui.requestRender();
			term.sendInput("x");
			scheduler.immediates.shift()?.();
			flushTimers(scheduler);

			expect(events[0]).toBe("input");
			expect(events).toContain("render");
		} finally {
			tui.stop();
		}
	});
});
