import { describe, expect, it } from "bun:test";
import { ManualRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, TUI } from "@veyyon/tui";

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

/** Run every armed frame, including a startup backstop this test does not care about. */
function flushArmedFrames(scheduler: ManualRenderScheduler): void {
	const armed = scheduler.armed.splice(0, scheduler.armed.length);
	for (const frame of armed) if (!frame.cancelled) frame.run();
}

describe("TUI input/render scheduling", () => {
	it("can process terminal input before a deferred ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new ManualRenderScheduler("queued");
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
			flushArmedFrames(scheduler);
			events.length = 0;
			scheduler.time = 100;

			tui.requestRender();
			term.sendInput("x");
			scheduler.immediates.shift()?.();
			flushArmedFrames(scheduler);

			expect(events[0]).toBe("input");
			expect(events).toContain("render");
		} finally {
			tui.stop();
		}
	});
});
